import { describe, it, expect, vi } from 'vitest';
import { destroyPrimaryTaskWindow } from './TaskWindowDestruction';
import type { ITaskRepository } from '../Task';
import type { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';

/** Resolves/rejects a promise only once `release`/`fail` is called — lets tests control interleaving. */
function makeGate<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Minimal in-memory stand-in for the one `ITaskRepository` method
 * `destroyPrimaryTaskWindow` actually calls — a faithful CAS: only clears
 * (and reports `true`) when `expectedWindowName` still matches the task's
 * CURRENT `tmuxWindow` at the moment it's called, exactly like the real
 * WHERE-guarded UPDATE (Task.ts's own doc comment on
 * `clearTmuxWindowIfMatches`).
 */
function makeTaskRepo(initialTmuxWindow: string | null) {
  let tmuxWindow = initialTmuxWindow;
  const clearTmuxWindowIfMatches = vi.fn((_id: number, expectedWindowName: string) => {
    if (tmuxWindow !== expectedWindowName) return false;
    tmuxWindow = null;
    return true;
  });
  return {
    repo: { clearTmuxWindowIfMatches } as unknown as Pick<ITaskRepository, 'clearTmuxWindowIfMatches'>,
    clearTmuxWindowIfMatches,
    setTmuxWindow: (name: string | null) => { tmuxWindow = name; },
  };
}

function makePaneEnvServiceSpy() {
  return { revokeForDestroyedWindow: vi.fn() } as unknown as Pick<TaskPaneEnvironmentService, 'revokeForDestroyedWindow'> as TaskPaneEnvironmentService;
}

describe('destroyPrimaryTaskWindow', () => {
  it('kills, revokes (reread confirms the window is still current), and cleans up on success', async () => {
    const { repo, clearTmuxWindowIfMatches } = makeTaskRepo('task-1');
    const paneEnvService = makePaneEnvServiceSpy();
    const onDestroyed = vi.fn();

    const outcome = await destroyPrimaryTaskWindow(
      1,
      'task-1',
      repo,
      paneEnvService,
      'window_killed_via_sessions_route',
      async () => ({ stdout: '', stderr: '', code: 0 }),
      onDestroyed,
    );

    expect(outcome.success).toBe(true);
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(1, 'task-1');
    expect(paneEnvService.revokeForDestroyedWindow).toHaveBeenCalledWith(1, 'window_killed_via_sessions_route');
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it('does NOT revoke (or fail) when the kill fails for a reason other than "already gone"', async () => {
    const { repo, clearTmuxWindowIfMatches } = makeTaskRepo('task-1');
    const paneEnvService = makePaneEnvServiceSpy();
    const onDestroyed = vi.fn();

    const outcome = await destroyPrimaryTaskWindow(
      1,
      'task-1',
      repo,
      paneEnvService,
      'window_killed_via_sessions_route',
      async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 }),
      onDestroyed,
    );

    expect(outcome.success).toBe(false);
    expect(clearTmuxWindowIfMatches).not.toHaveBeenCalled();
    expect(paneEnvService.revokeForDestroyedWindow).not.toHaveBeenCalled();
    expect(onDestroyed).not.toHaveBeenCalled();
  });

  // Issue #28 third-party review, second round: the core race this function
  // exists to close. A concurrent respawn for the SAME task can issue and
  // persist a newer window generation while this call's kill is still in
  // flight; the blanket `revokeForDestroyedWindow` this function calls on
  // success must never fire for a window the task has already moved on from.
  it('does NOT revoke when a concurrent rotation moves the task onto a NEW window while this kill is in flight', async () => {
    const { repo, setTmuxWindow, clearTmuxWindowIfMatches } = makeTaskRepo('task-1-gen1');
    const paneEnvService = makePaneEnvServiceSpy();
    const onDestroyed = vi.fn();
    const killGate = makeGate<{ stdout: string; stderr: string; code: number }>();

    const destroyPromise = destroyPrimaryTaskWindow(
      1,
      'task-1-gen1',
      repo,
      paneEnvService,
      'window_killed_via_sessions_route',
      () => killGate.promise,
      onDestroyed,
    );

    // While the kill is still pending, a concurrent respawn for the SAME
    // task completes and rotates the task onto a brand-new window
    // generation — exactly the interleaving `runExclusiveForTask` alone
    // cannot prevent for a caller that resolved its kill target BEFORE
    // acquiring the lock (this function's own `kill` callback is invoked
    // INSIDE the lock, but a caller could still pass a stale target; this
    // test simulates the task's row moving on regardless of how the target
    // was resolved).
    setTmuxWindow('task-1-gen2');

    killGate.release({ stdout: '', stderr: '', code: 0 });
    const outcome = await destroyPromise;

    expect(outcome.success).toBe(true);
    // The reread correctly reports "no longer current" — clearTmuxWindowIfMatches
    // is still called (it's the reread itself), but it must return false and
    // leave the newer generation's `tmuxWindow` alone.
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(1, 'task-1-gen1');
    // The critical assertion: the newer, still-live generation must NOT be
    // revoked by this call's blanket-for-task revoke.
    expect(paneEnvService.revokeForDestroyedWindow).not.toHaveBeenCalled();
    // Reference cleanup (e.g. windows table row removal) still runs — the
    // window this call was destroying really is gone, independent of
    // whether it was still the task's CURRENT window.
    expect(onDestroyed).toHaveBeenCalledTimes(1);
  });

  it('serializes two destroys for the same task — the second only starts once the first settles', async () => {
    const { repo } = makeTaskRepo('task-1');
    const paneEnvService = makePaneEnvServiceSpy();
    const order: string[] = [];
    const gateA = makeGate<{ stdout: string; stderr: string; code: number }>();

    const a = destroyPrimaryTaskWindow(1, 'task-1', repo, paneEnvService, 'reason_a', async () => {
      order.push('a-start');
      return gateA.promise;
    }, () => order.push('a-cleanup'));

    const b = destroyPrimaryTaskWindow(1, 'task-1', repo, paneEnvService, 'reason_b', async () => {
      order.push('b-start');
      return { stdout: '', stderr: '', code: 0 };
    }, () => order.push('b-cleanup'));

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a-start']);

    gateA.release({ stdout: '', stderr: '', code: 0 });
    await a;
    await b;

    expect(order).toEqual(['a-start', 'a-cleanup', 'b-start', 'b-cleanup']);
  });
});
