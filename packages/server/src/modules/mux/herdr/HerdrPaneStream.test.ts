import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HerdrPaneStream, type HerdrRpcFn } from './HerdrPaneStream';

function makeRead(text: string, revision: number, truncated = false) {
  return { read: { text, revision, truncated, pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', source: 'recent', format: 'text' } };
}

describe('HerdrPaneStream', () => {
  let rpc: HerdrRpcFn;
  let stream: HerdrPaneStream;
  let revision: number;
  let text: string;

  beforeEach(() => {
    vi.useFakeTimers();
    revision = 0;
    text = '';
    rpc = vi.fn(async () => makeRead(text, revision));
    stream = new HerdrPaneStream('test-pane-id', rpc);
  });

  afterEach(() => {
    stream.stop();
    vi.useRealTimers();
  });

  it('emits data events on new output', async () => {
    const chunks: string[] = [];
    stream.on('data', (d: string) => chunks.push(d));
    stream.on('error', () => {});
    stream.start();

    // First poll: captures initial state (no emission)
    await vi.advanceTimersByTimeAsync(10);

    // Advance revision with new content
    text = 'line1\nline2\n';
    revision = 1;
    await vi.advanceTimersByTimeAsync(500);

    // Next: overlap-based diff
    text = 'line2\nline3\n';
    revision = 2;
    await vi.advanceTimersByTimeAsync(500);

    expect(chunks.join('')).toContain('line3');
  });

  it('detects done marker', async () => {
    const markers: string[] = [];
    stream.on('marker', (type: string) => markers.push(type));
    stream.on('error', () => {});
    stream.setMarkers('AZITO_DONE_42_abc', 'AZITO_QUESTIONS_42_abc');
    stream.enableMarkerDetection();
    stream.start();

    // Initial read
    text = 'working...\n';
    revision = 1;
    await vi.advanceTimersByTimeAsync(10);

    // Output with marker
    text = 'working...\nAZITO_DONE_42_abc\n';
    revision = 2;
    await vi.advanceTimersByTimeAsync(500);

    expect(markers).toContain('phase_complete');
  });

  it('detects questions marker', async () => {
    const markers: Array<{ type: string; raw: string }> = [];
    stream.on('marker', (type: string, raw: string) => markers.push({ type, raw }));
    stream.on('error', () => {});
    stream.setMarkers('AZITO_DONE_42_abc', 'AZITO_QUESTIONS_42_abc');
    stream.enableMarkerDetection();
    stream.start();

    text = 'initial\n';
    revision = 1;
    await vi.advanceTimersByTimeAsync(10);

    text = 'initial\nAZITO_QUESTIONS_42_abc: [{"text":"q1","type":"select","options":["A","B"]}]\n';
    revision = 2;
    await vi.advanceTimersByTimeAsync(500);

    expect(markers.some((m) => m.type === 'questions_json')).toBe(true);
  });

  it('getFilePath returns empty string', () => {
    expect(stream.getFilePath()).toBe('');
  });

  it('emits error when no overlap found', async () => {
    const errors: Error[] = [];
    stream.on('error', (e: Error) => errors.push(e));

    // Set initial state before start so the first poll captures it
    text = 'aaa\nbbb\nccc';
    revision = 1;
    stream.start();
    await vi.advanceTimersByTimeAsync(10);

    // Completely different content — no overlap
    text = 'xxx\nyyy\nzzz';
    revision = 2;
    await vi.advanceTimersByTimeAsync(500);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('no overlap found');
    expect(stream.getBuffer()).toContain('xxx');
  });

  it('stops polling on stop()', async () => {
    stream.start();
    text = 'init\n';
    revision = 1;
    await vi.advanceTimersByTimeAsync(10);

    stream.stop();

    text = 'should not be seen\n';
    revision = 2;
    await vi.advanceTimersByTimeAsync(1000);

    expect(stream.getBuffer()).not.toContain('should not be seen');
  });

  it('skips poll when revision unchanged', async () => {
    stream.on('error', () => {});
    stream.start();
    text = 'data\n';
    revision = 1;
    await vi.advanceTimersByTimeAsync(10);

    // Let first content poll happen
    await vi.advanceTimersByTimeAsync(500);
    const bufAfterFirst = stream.getBuffer();

    // Same revision — no new data should be added
    await vi.advanceTimersByTimeAsync(500);
    expect(stream.getBuffer()).toBe(bufAfterFirst);
  });
});
