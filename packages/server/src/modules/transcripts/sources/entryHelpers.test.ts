import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { scanSessionTailState, TAIL_STATE_SCAN_WINDOWS } from './entryHelpers';
import type { TranscriptEntry } from './TranscriptSource';

/** `{"kind":"user"}` 形の行だけをエントリ化する最小 parseLine（housekeeping 行は null）。 */
function makeParseLine(): { parseLine: (line: string, lineStart: number) => TranscriptEntry | null; calls: string[] } {
  const calls: string[] = [];
  const parseLine = (line: string): TranscriptEntry | null => {
    calls.push(line);
    if (!line) return null;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (typeof record !== 'object' || record === null || !('kind' in record)) return null;
    const kind = (record as { kind: unknown }).kind;
    if (kind !== 'user') return null;
    const timestamp = (record as { timestamp?: unknown }).timestamp;
    return {
      uuid: 'u1',
      type: 'user',
      timestamp: typeof timestamp === 'string' ? timestamp : null,
      blocks: [],
    };
  };
  return { parseLine, calls };
}

function withFile<T>(dir: string, lines: string[], fn: (fd: number, size: number) => T): T {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const fd = fs.openSync(file, 'r');
  try {
    return fn(fd, fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

/** 意味を持たない大型 housekeeping 行（実データの attachment レコード相当）。 */
function housekeepingLine(bytes: number): string {
  return JSON.stringify({ attachment: { type: 'skill_listing', content: 'x'.repeat(bytes) } });
}

describe('scanSessionTailState', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tail-state-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('escalates the window when the 16KB tail is filled with housekeeping records (real sessions end with attachments)', () => {
    const lines = [
      JSON.stringify({ kind: 'user', timestamp: '2026-08-13T10:00:00.000Z' }),
      housekeepingLine(8 * 1024),
      housekeepingLine(8 * 1024),
      housekeepingLine(8 * 1024),
      JSON.stringify({ type: 'ai-title', aiTitle: 'resumed' }),
    ];
    const result = withFile(dir, lines, (fd, size) => scanSessionTailState(fd, size, makeParseLine().parseLine));
    expect(result.state).toBe('in_progress');
    expect(result.lastEntryTimestampMs).toBe(Date.parse('2026-08-13T10:00:00.000Z'));
  });

  it('keeps unknown when no meaningful entry exists within the 256KB cap', () => {
    const lines = [JSON.stringify({ kind: 'user', timestamp: '2026-08-13T10:00:00.000Z' })];
    // 最大窓（256KB）を確実に超える量の housekeeping を積む。
    const cap = TAIL_STATE_SCAN_WINDOWS[TAIL_STATE_SCAN_WINDOWS.length - 1];
    let filled = 0;
    while (filled <= cap + 32 * 1024) {
      const line = housekeepingLine(16 * 1024);
      lines.push(line);
      filled += line.length + 1;
    }
    const result = withFile(dir, lines, (fd, size) => scanSessionTailState(fd, size, makeParseLine().parseLine));
    expect(result.state).toBe('unknown');
    expect(result.lastEntryTimestampMs).toBeNull();
  });

  it('decides a small session within the first window (no escalation: every line is parsed exactly once)', () => {
    const lines = [
      JSON.stringify({ kind: 'user', timestamp: '2026-08-13T10:00:00.000Z' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'resumed' }),
    ];
    const { parseLine, calls } = makeParseLine();
    const result = withFile(dir, lines, (fd, size) => scanSessionTailState(fd, size, parseLine));
    expect(result.state).toBe('in_progress');
    // 窓が広がって再走査されていれば同じ行が2回以上パースされる（末尾改行由来の空セグメントを含めても重複はない）。
    expect(new Set(calls).size).toBe(calls.length);
  });
});
