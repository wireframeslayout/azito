import { describe, it, expect, afterEach } from 'vitest';
import { PaneOutputStream } from './PaneOutputStream';
import * as fs from 'fs';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls `getBuffer` until it stops changing for a short quiet period, instead of a
 * single fixed sleep. Needed for the large-write truncation test below: `tail -f`
 * reading + reassembling ~2.5MB (~25k lines) through processChunk can, under system
 * load, take much longer than a short fixed delay — and a fixed-length buffer size
 * check can't tell "settled" from "mid-stream, happens to be exactly at the cap"
 * apart, since every truncating append re-slices back down to the same length.
 */
async function waitForBufferSettled(getBuffer: () => string, timeoutMs = 10_000): Promise<string> {
  const start = Date.now();
  let last = getBuffer();
  let stableSince = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(50);
    const current = getBuffer();
    if (current === last) {
      if (Date.now() - stableSince >= 150) return current;
    } else {
      last = current;
      stableSince = Date.now();
    }
  }
  throw new Error('waitForBufferSettled: buffer did not settle within timeout');
}

describe('PaneOutputStream', () => {
  let stream: PaneOutputStream | null = null;

  afterEach(() => {
    if (stream) { stream.stop(); stream = null; }
  });

  it('should emit data when file is written to', async () => {
    stream = new PaneOutputStream('test-1');
    stream.start();
    const chunks: string[] = [];
    stream.on('data', (chunk: string) => chunks.push(chunk));

    fs.appendFileSync(stream.getFilePath(), 'hello world\n');
    await sleep(300);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('hello world');
  });

  it('should detect PHASE_COMPLETE marker', async () => {
    stream = new PaneOutputStream('test-2');
    stream.start();
    stream.enableMarkerDetection();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    fs.appendFileSync(stream.getFilePath(), 'plan output here\nPHASE_COMPLETE\n');
    await sleep(300);

    expect(markers).toContain('phase_complete');
  });

  it('should detect QUESTIONS_JSON marker with valid JSON', async () => {
    stream = new PaneOutputStream('test-3');
    stream.start();
    stream.enableMarkerDetection();
    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    const questionsJson = 'QUESTIONS_JSON: [{"text":"カンバンの構成は？","type":"select","options":["5列","9列"]}]\n';
    fs.appendFileSync(stream.getFilePath(), questionsJson);
    await sleep(300);

    const qMarker = markers.find(m => m.type === 'questions_json');
    expect(qMarker).toBeDefined();
    const parsed = JSON.parse(qMarker!.raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('カンバンの構成は？');
  });

  it('should NOT detect template QUESTIONS_JSON', async () => {
    stream = new PaneOutputStream('test-4');
    stream.start();
    stream.enableMarkerDetection();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    fs.appendFileSync(stream.getFilePath(), 'QUESTIONS_JSON: [{"text":"question text","type":"select","options":["option1","option2"]},{"text":"open question","type":"text"}]\n');
    await sleep(300);

    expect(markers.filter(m => m === 'questions_json')).toHaveLength(0);
  });

  it('should accumulate buffer across multiple writes', async () => {
    stream = new PaneOutputStream('test-5');
    stream.start();

    fs.appendFileSync(stream.getFilePath(), 'first line\n');
    await sleep(300);
    fs.appendFileSync(stream.getFilePath(), 'second line\nPHASE_COMPLETE\n');
    await sleep(300);

    expect(stream.getBuffer()).toContain('first line');
    expect(stream.getBuffer()).toContain('second line');
    expect(stream.getBuffer()).toContain('PHASE_COMPLETE');
  });

  it('should handle clean text marker detection (ANSI stripped by pipe-pane sed)', async () => {
    stream = new PaneOutputStream('test-6');
    stream.start();
    stream.enableMarkerDetection();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    fs.appendFileSync(stream.getFilePath(), 'PHASE_COMPLETE\n');
    await sleep(300);

    expect(markers).toContain('phase_complete');
  });

  it('should NOT detect markers before enableMarkerDetection is called', async () => {
    stream = new PaneOutputStream('test-guard-1');
    stream.start();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    fs.appendFileSync(stream.getFilePath(), 'template PHASE_COMPLETE\n');
    await sleep(300);

    expect(markers).toHaveLength(0);
  });

  it('should detect markers only in new output after enableMarkerDetection', async () => {
    stream = new PaneOutputStream('test-guard-2');
    stream.start();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    fs.appendFileSync(stream.getFilePath(), 'template PHASE_COMPLETE here\n');
    await sleep(300);
    expect(markers).toHaveLength(0);

    stream.enableMarkerDetection();

    fs.appendFileSync(stream.getFilePath(), 'agent output\nPHASE_COMPLETE\n');
    await sleep(300);
    expect(markers).toContain('phase_complete');
  });

  it('should ignore QUESTIONS_JSON in initial buffer after enableMarkerDetection', async () => {
    stream = new PaneOutputStream('test-guard-3');
    stream.start();
    const markers: Array<{ type: string }> = [];
    stream.on('marker', (type: string) => markers.push({ type }));

    fs.appendFileSync(stream.getFilePath(), 'QUESTIONS_JSON: [{"text":"real question","type":"text"}]\n');
    await sleep(300);

    stream.enableMarkerDetection();

    fs.appendFileSync(stream.getFilePath(), 'agent is thinking...\n');
    await sleep(300);
    expect(markers.filter(m => m.type === 'questions_json')).toHaveLength(0);
  });

  it('should clean up file on stop', () => {
    stream = new PaneOutputStream('test-7');
    stream.start();
    const filePath = stream.getFilePath();
    expect(fs.existsSync(filePath)).toBe(true);

    stream.stop();
    stream = null;
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('should detect QUESTIONS_JSON with multiple nested options', async () => {
    stream = new PaneOutputStream('test-8');
    stream.start();
    stream.enableMarkerDetection();
    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    const json = 'QUESTIONS_JSON: [{"text":"Q1","type":"select","options":["A","B","C"]},{"text":"Q2","type":"select","options":["X","Y"]}]\n';
    fs.appendFileSync(stream.getFilePath(), json);
    await sleep(300);

    const qMarker = markers.find(m => m.type === 'questions_json');
    expect(qMarker).toBeDefined();
    const parsed = JSON.parse(qMarker!.raw);
    expect(parsed).toHaveLength(2);
  });

  it('should detect unique markers when set', async () => {
    stream = new PaneOutputStream('test-unique-1');
    stream.start();
    stream.setMarkers('AZITO_DONE_42_abc123', 'AZITO_QUESTIONS_42_abc123');
    stream.enableMarkerDetection();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    fs.appendFileSync(stream.getFilePath(), 'some output\nAZITO_DONE_42_abc123\n');
    await sleep(300);

    expect(markers).toContain('phase_complete');
  });

  it('should detect unique question markers', async () => {
    stream = new PaneOutputStream('test-unique-2');
    stream.start();
    stream.setMarkers('AZITO_DONE_42_xyz789', 'AZITO_QUESTIONS_42_xyz789');
    stream.enableMarkerDetection();
    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    fs.appendFileSync(stream.getFilePath(), 'AZITO_QUESTIONS_42_xyz789: [{"text":"質問","type":"text"}]\n');
    await sleep(300);

    const qMarker = markers.find(m => m.type === 'questions_json');
    expect(qMarker).toBeDefined();
    const parsed = JSON.parse(qMarker!.raw);
    expect(parsed[0].text).toBe('質問');
  });

  it('should detect QUESTIONS_JSON spanning multiple lines (terminal line wrap)', async () => {
    stream = new PaneOutputStream('test-multiline-1');
    stream.start();
    stream.setMarkers('AZITO_DONE_42_ml1', 'AZITO_QUESTIONS_42_ml1');
    stream.enableMarkerDetection();
    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    // Simulate tmux terminal wrapping a long JSON across multiple lines
    fs.appendFileSync(stream.getFilePath(), '  AZITO_QUESTIONS_42_ml1: [{"text":"カンバン表示のカラムについて","type":"select","options":["全ステータスをカラムにする","グルーピング",\n');
    await sleep(100);
    fs.appendFileSync(stream.getFilePath(), '"カスタム"]},{"text":"サイドバーの表示形式は？","type":"select","options":["横スクロール",\n');
    await sleep(100);
    fs.appendFileSync(stream.getFilePath(), '"リスト表示のみ","折りたたみセクション"]}]\n');
    await sleep(300);

    const qMarker = markers.find(m => m.type === 'questions_json');
    expect(qMarker).toBeDefined();
    const parsed = JSON.parse(qMarker!.raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('カンバン表示のカラムについて');
    expect(parsed[1].text).toBe('サイドバーの表示形式は？');
  });

  it('should detect generic QUESTIONS_JSON spanning multiple lines', async () => {
    stream = new PaneOutputStream('test-multiline-2');
    stream.start();
    stream.enableMarkerDetection();
    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    fs.appendFileSync(stream.getFilePath(), 'QUESTIONS_JSON: [{"text":"Q1","type":"select","options":["A",\n');
    await sleep(100);
    fs.appendFileSync(stream.getFilePath(), '"B","C"]}]\n');
    await sleep(300);

    const qMarker = markers.find(m => m.type === 'questions_json');
    expect(qMarker).toBeDefined();
    const parsed = JSON.parse(qMarker!.raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].options).toEqual(['A', 'B', 'C']);
  });

  it('should emulate \\r by keeping only text after last \\r', async () => {
    stream = new PaneOutputStream('test-cr-emulate');
    stream.start();
    const chunks: string[] = [];
    stream.on('data', (chunk: string) => chunks.push(chunk));

    // Simulate spinner overwrites: "spinner1\rspinner2\rfinal content"
    fs.appendFileSync(stream.getFilePath(), 'spinner1\rspinner2\rfinal content\n');
    await sleep(300);

    const output = chunks.join('');
    expect(output).toContain('final content');
    expect(output).not.toContain('spinner1');
    expect(output).not.toContain('spinner2');
  });

  it('should detect markers after \\r noise is stripped', async () => {
    stream = new PaneOutputStream('test-cr-marker');
    stream.start();
    stream.setMarkers('AZITO_DONE_42_cr1', 'AZITO_QUESTIONS_42_cr1');
    stream.enableMarkerDetection();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    // DONE marker comes after spinner overwrites on same line
    fs.appendFileSync(stream.getFilePath(), '✶ Whatchamacalliting…\r✻ Canoodling…\rAZITO_DONE_42_cr1\n');
    await sleep(300);

    expect(markers).toContain('phase_complete');
  });

  it('should produce clean plan output without spinner noise', async () => {
    stream = new PaneOutputStream('test-cr-plan');
    stream.start();
    const chunks: string[] = [];
    stream.on('data', (chunk: string) => chunks.push(chunk));

    // Simulate real pipe-pane output: spinner noise then actual plan
    fs.appendFileSync(stream.getFilePath(), '✶ Whatchamacalliting…\r✻ Working…\r● 全体像を把握できました。\n');
    fs.appendFileSync(stream.getFilePath(), '## 実装計画\n');
    fs.appendFileSync(stream.getFilePath(), '### 要件\n');
    fs.appendFileSync(stream.getFilePath(), '- カンバン表示の追加\n');
    await sleep(300);

    const output = chunks.join('');
    expect(output).toContain('● 全体像を把握できました。');
    expect(output).toContain('## 実装計画');
    expect(output).toContain('- カンバン表示の追加');
    expect(output).not.toContain('Whatchamacalliting');
    expect(output).not.toContain('Working…');
  });

  it('should detect QUESTIONS marker split by \\r from JSON (pipe-pane)', async () => {
    stream = new PaneOutputStream('test-cr-split');
    stream.start();
    stream.setMarkers('AZITO_DONE_42_split', 'AZITO_QUESTIONS_42_split');
    stream.enableMarkerDetection();
    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    // Real pipe-pane format: marker and JSON separated by \r
    fs.appendFileSync(stream.getFilePath(), '\r  AZITO_QUESTIONS_42_split:\r  [{"text":"質問1","type":"select","options":["A","B"]}]\r\r\n');
    await sleep(300);

    const qMarker = markers.find(m => m.type === 'questions_json');
    expect(qMarker).toBeDefined();
    const parsed = JSON.parse(qMarker!.raw);
    expect(parsed[0].text).toBe('質問1');
  });

  it('should detect DONE marker with \\r\\n line endings', async () => {
    stream = new PaneOutputStream('test-cr-2');
    stream.start();
    stream.setMarkers('AZITO_DONE_42_cr2', 'AZITO_QUESTIONS_42_cr2');
    stream.enableMarkerDetection();
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));

    fs.appendFileSync(stream.getFilePath(), 'output\r\nAZITO_DONE_42_cr2\r\n');
    await sleep(300);

    expect(markers).toContain('phase_complete');
  });

  // ─── Signal file usage tests ───
  // Verifies that PaneOutputStream can be used as a signal file monitor:
  // start → setMarkers → enableMarkerDetection immediately → worker appends marker line.

  it('signal file: detects done marker written by worker shell command', async () => {
    stream = new PaneOutputStream('test-sig-done-1');
    stream.start();
    stream.setMarkers('AZITO_DONE_1_abc', 'AZITO_Q_1_abc');
    stream.enableMarkerDetection();

    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    // Worker runs: echo "AZITO_DONE_1_abc" >> <signalFilePath>
    fs.appendFileSync(stream.getFilePath(), 'AZITO_DONE_1_abc\n');
    await sleep(300);

    expect(markers.find(m => m.type === 'phase_complete')).toBeDefined();
    stream.stop();
    stream = null;
  });

  it('signal file: detects questions marker written by worker shell command', async () => {
    stream = new PaneOutputStream('test-sig-q-1');
    stream.start();
    stream.setMarkers('AZITO_DONE_1_def', 'AZITO_Q_1_def');
    stream.enableMarkerDetection();

    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));

    // Worker runs: echo 'AZITO_Q_1_def: [{"text":"q1","type":"text"}]' >> <signalFilePath>
    fs.appendFileSync(stream.getFilePath(), 'AZITO_Q_1_def: [{"text":"q1","type":"text"}]\n');
    await sleep(300);

    const qMarker = markers.find(m => m.type === 'questions_json');
    expect(qMarker).toBeDefined();
    const parsed = JSON.parse(qMarker!.raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('q1');
    expect(parsed[0].type).toBe('text');
    stream.stop();
    stream = null;
  });

  it('should truncate buffer when exceeding 2MB limit, preserving tail', async () => {
    stream = new PaneOutputStream('test-truncate');
    stream.start();

    // Write ~2.5MB of data (each line ~100 chars, ~25000 lines)
    const line = 'A'.repeat(99) + '\n';
    const bigChunk = line.repeat(25000); // 2.5MB
    fs.appendFileSync(stream.getFilePath(), bigChunk);
    const buffer = await waitForBufferSettled(() => stream!.getBuffer());
    // Buffer should be capped around 2MB + truncation prefix
    expect(buffer.length).toBeLessThan(2.2 * 1024 * 1024);
    expect(buffer.startsWith('[...truncated]\n')).toBe(true);
    // Tail content should be preserved
    expect(buffer.endsWith(line)).toBe(true);
    stream.stop();
    stream = null;
  });
});
