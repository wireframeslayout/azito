import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startParentWatch } from './parentWatch';

describe('startParentWatch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(creations: Array<string | null>, alive: () => boolean = () => true) {
    const onGone = vi.fn();
    const onUnverifiable = vi.fn();
    const readCreation = vi.fn(async () => (creations.length > 1 ? creations.shift()! : creations[0]!));
    const promise = startParentWatch({ pid: 42, aliveIntervalMs: 3000, verifyIntervalMs: 30_000, isAlive: alive, readCreation, onGone, onUnverifiable });
    return { onGone, onUnverifiable, readCreation, promise };
  }

  it('ends when the parent is not there any more (the cheap probe)', async () => {
    let up = true;
    const { onGone, promise } = setup(['100'], () => up);
    await promise;
    await vi.advanceTimersByTimeAsync(9000);
    expect(onGone).not.toHaveBeenCalled();
    up = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith('parent process 42 is gone');
  });

  it('ends when the pid now belongs to another process (a different creation time), which the probe alone would call alive', async () => {
    const { onGone, readCreation, promise } = setup(['100', '100', '999']);
    await promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onGone).not.toHaveBeenCalled(); // same creation time
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onGone).toHaveBeenCalledWith(expect.stringContaining('now belongs to another process'));
    expect(readCreation).toHaveBeenCalledTimes(3);
  });

  it('does not end for a creation time it cannot read, and says it only watches the pid', async () => {
    const { onGone, onUnverifiable, promise } = setup([null]);
    await promise;
    expect(onUnverifiable).toHaveBeenCalledWith(expect.stringContaining('only its existence is watched'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('ignores a later unreadable time', async () => {
    const { onGone, promise } = setup(['100', null]);
    await promise;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('calls onGone once, and stop() ends the watch', async () => {
    const first = setup(['100'], () => false);
    await first.promise;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(first.onGone).toHaveBeenCalledTimes(1);

    const second = setup(['100'], () => false);
    (await second.promise).stop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(second.onGone).not.toHaveBeenCalled();
  });
});
