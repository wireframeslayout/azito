import { describe, expect, it } from 'vitest';
import { ParentSessionCache } from './ParentSessionCache';
import type { Window } from '../windows/Window';

const SID = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const TTLS = { linkedMs: 30_000, unlinkedMs: 5000 };

function windowOf(overrides: Partial<Window> = {}): Window {
  return { id: 1, serverName: 'local', agentSessionId: SID, taskId: null, ...overrides } as unknown as Window;
}

describe('ParentSessionCache', () => {
  it('keeps a parent backed by the window agentSessionId for the long TTL', () => {
    let now = 1000;
    const cache = new ParentSessionCache(TTLS, () => now);
    cache.set(windowOf(), SID);
    now += 29_999;
    expect(cache.get(windowOf())).toBe(SID);
    now += 1;
    expect(cache.get(windowOf())).toBeUndefined();
  });

  it('keeps a parent of a window with no DB link only for the short TTL', () => {
    let now = 1000;
    const window = windowOf({ agentSessionId: null });
    const cache = new ParentSessionCache(TTLS, () => now);
    cache.set(window, SID);
    now += 4999;
    expect(cache.get(window)).toBe(SID);
    now += 1;
    expect(cache.get(window)).toBeUndefined();
  });

  it('uses the short TTL when the resolved parent differs from the DB agentSessionId', () => {
    let now = 1000;
    const cache = new ParentSessionCache(TTLS, () => now);
    cache.set(windowOf(), OTHER);
    now += 4999;
    expect(cache.get(windowOf())).toBe(OTHER);
    now += 1;
    expect(cache.get(windowOf())).toBeUndefined();
  });

  it('is not used once the window link changes or for another window', () => {
    const cache = new ParentSessionCache(TTLS, () => 0);
    cache.set(windowOf(), SID);
    expect(cache.get(windowOf({ id: 2 }))).toBeUndefined();
    expect(cache.get(windowOf({ taskId: 7 }))).toBeUndefined();
    // The changed link dropped the entry: the original link no longer hits either.
    expect(cache.get(windowOf())).toBeUndefined();
  });

  it('forgets a deleted window', () => {
    const cache = new ParentSessionCache(TTLS, () => 0);
    cache.set(windowOf(), SID);
    cache.delete(1);
    expect(cache.get(windowOf())).toBeUndefined();
  });
});
