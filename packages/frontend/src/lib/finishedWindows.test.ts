import { describe, it, expect } from 'vitest';
import {
  activityKey,
  FINISHED_TTL_MS,
  pruneFinished,
  removeFinished,
  upsertFinished,
  type FinishedEntry,
} from './finishedWindows';

function entry(overrides: Partial<FinishedEntry> = {}): FinishedEntry {
  return { serverName: 'local', target: 'azito:win--a', finishedAt: 1_000, ...overrides };
}

describe('pruneFinished', () => {
  it('drops entries older than the TTL and keeps the rest', () => {
    const now = 10 * FINISHED_TTL_MS;
    const fresh = entry({ target: 'azito:fresh', finishedAt: now - 60_000 });
    const stale = entry({ target: 'azito:stale', finishedAt: now - FINISHED_TTL_MS - 1 });
    expect(pruneFinished([fresh, stale], now)).toEqual([fresh]);
  });

  it('returns the same reference when nothing expired (no needless re-render)', () => {
    const now = 10 * FINISHED_TTL_MS;
    const list = [entry({ finishedAt: now - 1 })];
    expect(pruneFinished(list, now)).toBe(list);
  });
});

describe('upsertFinished', () => {
  it('appends a completion for a window with no finished row yet', () => {
    const list = [entry({ target: 'azito:other' })];
    const added = entry({ target: 'azito:win--a', finishedAt: 5_000 });
    expect(upsertFinished(list, added)).toEqual([list[0], added]);
  });

  it('replaces the existing row for the same window instead of discarding the new completion', () => {
    // 同じウィンドウが2ターン目を開始・完了した場合（ポーリング間隔内で working を挟むこともある）。
    // 古い行を据え置くと「完了 · 今」が更新されず、未読数にも出ない（未読キーは finishedAt を含む）。
    const first = entry({ finishedAt: 1_000, label: 'old', taskId: 1 });
    const second = entry({ finishedAt: 9_000, label: 'new', taskId: 2 });
    const result = upsertFinished([first], second);
    expect(result).toEqual([second]);
    expect(result[0].finishedAt).toBe(9_000);
  });

  it('matches on server+target, not on the other metadata', () => {
    const first = entry({ serverName: 'local', target: 'azito:win--a', finishedAt: 1_000 });
    const otherServer = entry({ serverName: 'remote', target: 'azito:win--a', finishedAt: 2_000 });
    expect(upsertFinished([first], otherServer)).toHaveLength(2);
  });
});

describe('removeFinished', () => {
  it('removes the row for a key and leaves the others', () => {
    const a = entry({ target: 'azito:win--a' });
    const b = entry({ target: 'azito:win--b' });
    expect(removeFinished([a, b], activityKey('local', 'azito:win--a'))).toEqual([b]);
  });

  it('returns the same reference when the key is absent', () => {
    const list = [entry()];
    expect(removeFinished(list, activityKey('local', 'azito:nope'))).toBe(list);
  });
});
