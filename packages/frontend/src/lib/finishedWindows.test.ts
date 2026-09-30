import { describe, it, expect } from 'vitest';
import {
  activityKey,
  activityKeyForEntry,
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

describe('activityKey with windowId', () => {
  it('uses wid: prefix when windowId is provided', () => {
    expect(activityKey('local', 'azito:win--a', 42)).toBe('wid:42');
  });

  it('falls back to windowKey when windowId is undefined', () => {
    expect(activityKey('local', 'azito:win--a')).toBe(activityKey('local', 'azito:win--a', undefined));
  });

  it('activityKeyForEntry uses windowId when available', () => {
    const e = entry({ windowId: 99 });
    expect(activityKeyForEntry(e)).toBe('wid:99');
  });

  it('activityKeyForEntry falls back to target when no windowId', () => {
    const e = entry({ windowId: undefined });
    expect(activityKeyForEntry(e)).toBe(activityKey('local', 'azito:win--a'));
  });
});

describe('upsertFinished with windowId', () => {
  it('matches by windowId when present', () => {
    const first = entry({ windowId: 10, finishedAt: 1_000 });
    const second = entry({ windowId: 10, target: 'azito:different', finishedAt: 9_000 });
    const result = upsertFinished([first], second);
    expect(result).toHaveLength(1);
    expect(result[0].finishedAt).toBe(9_000);
  });

  it('does not match windowId entry with target-only entry', () => {
    const withId = entry({ windowId: 10, finishedAt: 1_000 });
    const withoutId = entry({ target: 'azito:win--a', finishedAt: 2_000 });
    const result = upsertFinished([withId], withoutId);
    expect(result).toHaveLength(2);
  });
});
