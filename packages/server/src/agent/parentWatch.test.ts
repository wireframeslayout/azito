import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startParentWatch } from './parentWatch';

describe('startParentWatch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** `creations` are the answers of readCreation in order; the last one repeats. */
  function setup(creations: Array<string | null>, alive: () => boolean = () => true, readCreation?: () => Promise<string | null>) {
    const onGone = vi.fn();
    const onUnverifiable = vi.fn();
    const onVerifiable = vi.fn();
    const read = vi.fn(readCreation ?? (async () => (creations.length > 1 ? creations.shift()! : creations[0]!)));
    const watch = startParentWatch({ pid: 42, aliveIntervalMs: 3000, verifyIntervalMs: 30_000, isAlive: alive, readCreation: read, onGone, onUnverifiable, onVerifiable });
    return { onGone, onUnverifiable, onVerifiable, readCreation: read, watch };
  }

  it('ends when the parent is not there any more (the cheap probe)', async () => {
    let up = true;
    const { onGone } = setup(['100'], () => up);
    await vi.advanceTimersByTimeAsync(9000);
    expect(onGone).not.toHaveBeenCalled();
    up = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(onGone).toHaveBeenCalledTimes(1);
    expect(onGone).toHaveBeenCalledWith('parent process 42 is gone');
  });

  it('starts the probe without waiting for the first creation time', async () => {
    // A read that never answers: the 3 s probe still ends the agent when the parent is gone.
    const { onGone } = setup([], () => false, () => new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(3000);
    expect(onGone).toHaveBeenCalledWith('parent process 42 is gone');
  });

  it('ends when the pid now belongs to another process (a different creation time), which the probe alone would call alive', async () => {
    const { onGone, readCreation } = setup(['100', '100', '999']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onGone).not.toHaveBeenCalled(); // same creation time
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onGone).toHaveBeenCalledWith(expect.stringContaining('now belongs to another process'));
    expect(readCreation).toHaveBeenCalledTimes(3);
  });

  it('warns once when the creation time cannot be read time after time, and never ends for it', async () => {
    const { onGone, onUnverifiable } = setup([null]);
    await vi.advanceTimersByTimeAsync(30_000); // 2nd read
    expect(onUnverifiable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); // 3rd read
    expect(onUnverifiable).toHaveBeenCalledTimes(1);
    expect(onUnverifiable).toHaveBeenCalledWith(expect.stringContaining('only its existence is watched'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onUnverifiable).toHaveBeenCalledTimes(1);
    expect(onGone).not.toHaveBeenCalled();
  });

  it('says so when reading works again, and warns again for a later streak', async () => {
    const { onUnverifiable, onVerifiable, onGone } = setup([null, null, null, '100', null, null, null, '100', '999']);
    await vi.advanceTimersByTimeAsync(60_000); // reads 1-3: warned
    expect(onUnverifiable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); // read 4: recovered, and '100' is remembered
    expect(onVerifiable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000); // reads 5-7: a new streak
    expect(onUnverifiable).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000); // read 8: same time as before, fine
    expect(onVerifiable).toHaveBeenCalledTimes(2);
    expect(onGone).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); // read 9: another process
    expect(onGone).toHaveBeenCalledWith(expect.stringContaining('now belongs to another process'));
  });

  it('ignores a single unreadable time among readable ones', async () => {
    const { onGone, onUnverifiable } = setup(['100', null, '100']);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(onGone).not.toHaveBeenCalled();
    expect(onUnverifiable).not.toHaveBeenCalled();
  });

  it('calls onGone once, and stop() ends the watch', async () => {
    const first = setup(['100'], () => false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(first.onGone).toHaveBeenCalledTimes(1);

    const second = setup(['100'], () => false);
    second.watch.stop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(second.onGone).not.toHaveBeenCalled();
  });
});
