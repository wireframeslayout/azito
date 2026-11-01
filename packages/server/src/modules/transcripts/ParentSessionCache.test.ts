import { describe, expect, it } from 'vitest';
import { ParentSessionCache } from './ParentSessionCache';
import type { Window } from '../windows/Window';

const SID = '11111111-1111-1111-1111-111111111111';

function windowOf(overrides: Partial<Window> = {}): Window {
  return { id: 1, serverName: 'local', agentSessionId: SID, taskId: null, ...overrides } as unknown as Window;
}

describe('ParentSessionCache', () => {
  it('returns the parent until the TTL passes', () => {
    let now = 1000;
    const cache = new ParentSessionCache(5000, () => now);
    cache.set(windowOf(), SID);
    expect(cache.get(windowOf())).toBe(SID);
    now += 4999;
    expect(cache.get(windowOf())).toBe(SID);
    now += 1;
    expect(cache.get(windowOf())).toBeUndefined();
  });

  it('is not used once the window link changes or for another window', () => {
    const cache = new ParentSessionCache(5000, () => 0);
    cache.set(windowOf(), SID);
    expect(cache.get(windowOf({ id: 2 }))).toBeUndefined();
    expect(cache.get(windowOf({ taskId: 7 }))).toBeUndefined();
    // The changed link dropped the entry: the original link no longer hits either.
    expect(cache.get(windowOf())).toBeUndefined();
  });

  it('forgets a deleted window', () => {
    const cache = new ParentSessionCache(5000, () => 0);
    cache.set(windowOf(), SID);
    cache.delete(1);
    expect(cache.get(windowOf())).toBeUndefined();
  });
});
