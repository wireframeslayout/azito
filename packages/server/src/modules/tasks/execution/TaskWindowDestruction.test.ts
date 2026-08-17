import { describe, it, expect, vi } from 'vitest';
import { destroyPrimaryTaskWindow, destroyPrimaryTaskWindowsForSessionKill } from './TaskWindowDestruction';
import { runExclusiveForTask } from './WindowRotation';
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

/** Same CAS semantics as makeTaskRepo, but tracks `tmuxWindow` per taskId (a whole session can span multiple tasks). */
function makeMultiTaskRepo(initial: Record<number, string | null>) {
  const tmuxWindows = new Map<number, string | null>(Object.entries(initial).map(([id, w]) => [Number(id), w]));
  const clearTmuxWindowIfMatches = vi.fn((id: number, expectedWindowName: string) => {
    if (tmuxWindows.get(id) !== expectedWindowName) return false;
    tmuxWindows.set(id, null);
    return true;
  });
  return {
    repo: { clearTmuxWindowIfMatches } as unknown as Pick<ITaskRepository, 'clearTmuxWindowIfMatches'>,
    clearTmuxWindowIfMatches,
    setTmuxWindow: (id: number, name: string | null) => tmuxWindows.set(id, name),
  };
}

describe('destroyPrimaryTaskWindowsForSessionKill', () => {
  it('kills once, then rereads/revokes/cleans up every window', async () => {
    const { repo, clearTmuxWindowIfMatches } = makeMultiTaskRepo({ 1: 'task-1', 2: 'task-2' });
    const paneEnvService = makePaneEnvServiceSpy();
    const killSession = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const onDestroyed1 = vi.fn();
    const onDestroyed2 = vi.fn();
    const resolveWindows = vi.fn(() => [
      { taskId: 1, windowName: 'task-1', target: 'session:task-1', onDestroyed: onDestroyed1 },
      { taskId: 2, windowName: 'task-2', target: 'session:task-2', onDestroyed: onDestroyed2 },
    ]);

    const { outcome, handledTargets } = await destroyPrimaryTaskWindowsForSessionKill(
      resolveWindows,
      repo,
      paneEnvService,
      'window_killed_via_session_delete',
      killSession,
    );

    expect(outcome.success).toBe(true);
    expect(killSession).toHaveBeenCalledTimes(1);
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(1, 'task-1');
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(2, 'task-2');
    expect(paneEnvService.revokeForDestroyedWindow).toHaveBeenCalledWith(1, 'window_killed_via_session_delete');
    expect(paneEnvService.revokeForDestroyedWindow).toHaveBeenCalledWith(2, 'window_killed_via_session_delete');
    expect(onDestroyed1).toHaveBeenCalledTimes(1);
    expect(onDestroyed2).toHaveBeenCalledTimes(1);
    expect(handledTargets).toEqual(new Set(['session:task-1', 'session:task-2']));
  });

  it('does not revoke or clean up when the kill fails', async () => {
    const { repo, clearTmuxWindowIfMatches } = makeMultiTaskRepo({ 1: 'task-1' });
    const paneEnvService = makePaneEnvServiceSpy();
    const onDestroyed = vi.fn();

    const { outcome, handledTargets } = await destroyPrimaryTaskWindowsForSessionKill(
      () => [{ taskId: 1, windowName: 'task-1', target: 'session:task-1', onDestroyed }],
      repo,
      paneEnvService,
      'window_killed_via_session_delete',
      async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 }),
    );

    expect(outcome.success).toBe(false);
    expect(clearTmuxWindowIfMatches).not.toHaveBeenCalled();
    expect(paneEnvService.revokeForDestroyedWindow).not.toHaveBeenCalled();
    expect(onDestroyed).not.toHaveBeenCalled();
    expect(handledTargets.size).toBe(0);
  });

  // Issue #28 third-party review, D-track fix 1 — the core race this function
  // exists to close. Session-wide kill vs. a concurrent respawn for one of
  // the SAME tasks: the respawn must not be able to land a new window
  // generation while the session kill's "kill -> reread -> revoke -> cleanup"
  // span is in flight, and vice versa.
  it('locks ALL affected task IDs before killing — a concurrent respawn for one of them cannot interleave', async () => {
    const { repo, setTmuxWindow, clearTmuxWindowIfMatches } = makeMultiTaskRepo({ 1: 'task-1-gen1', 2: 'task-2' });
    const paneEnvService = makePaneEnvServiceSpy();
    const order: string[] = [];
    const killGate = (() => {
      let release!: (v: { stdout: string; stderr: string; code: number }) => void;
      const promise = new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => { release = resolve; });
      return { promise, release };
    })();
    const resolveWindows = () => [
      { taskId: 1, windowName: 'task-1-gen1', target: 'session:task-1-gen1', onDestroyed: () => order.push('session-kill-cleanup-1') },
      { taskId: 2, windowName: 'task-2', target: 'session:task-2', onDestroyed: () => order.push('session-kill-cleanup-2') },
    ];

    const sessionKillPromise = destroyPrimaryTaskWindowsForSessionKill(
      resolveWindows,
      repo,
      paneEnvService,
      'window_killed_via_session_delete',
      async () => {
        order.push('session-kill-start');
        return killGate.promise;
      },
    );

    // A concurrent respawn for task 1 (the same taskId the session kill is
    // about to destroy a window for) queues behind the session kill's lock —
    // it must NOT run until the session kill's whole span (kill -> reread ->
    // revoke -> cleanup) has settled.
    const respawnPromise = runExclusiveForTask(1, async () => {
      order.push('respawn-start');
      setTmuxWindow(1, 'task-1-gen2');
      order.push('respawn-done');
      return { stdout: '', stderr: '', code: 0 };
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Only the session kill's own (gated) kill call has run so far — the
    // respawn is still queued behind the lock.
    expect(order).toEqual(['session-kill-start']);

    killGate.release({ stdout: '', stderr: '', code: 0 });
    const { outcome } = await sessionKillPromise;
    await respawnPromise;

    expect(outcome.success).toBe(true);
    // The session kill's reread ran BEFORE the respawn touched task 1's
    // window — so it correctly saw the OLD generation as still current and
    // revoked it (the respawn had not landed a new one yet).
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(1, 'task-1-gen1');
    expect(paneEnvService.revokeForDestroyedWindow).toHaveBeenCalledWith(1, 'window_killed_via_session_delete');
    expect(order).toEqual([
      'session-kill-start',
      'session-kill-cleanup-1',
      'session-kill-cleanup-2',
      'respawn-start',
      'respawn-done',
    ]);
  });

  // Follow-up fix (Issue #28 batch review) — the REVERSE ordering from the
  // test above: the respawn is ALREADY RUNNING (holds task 1's rotation
  // queue) by the time the session kill is issued, so the session kill has
  // to WAIT on the lock before it even starts. A version of this function
  // that resolved its window snapshot ONCE, before ever touching the lock,
  // would still be holding the PRE-respawn `windowName` once it finally gets
  // the lock — `clearTmuxWindowIfMatches(1, 'task-1-gen1')` would then
  // mismatch the respawn's already-persisted `task-1-gen2` and skip the
  // revoke entirely, even though `killSession` (session-wide) is about to
  // destroy that new window right along with everything else. The fix is to
  // re-resolve the snapshot INSIDE the lock, right before the kill, so it
  // always reflects whatever the respawn actually landed.
  it('re-reads the window snapshot INSIDE the lock, so a respawn that already landed a NEW window before the session kill acquired the lock still gets correctly revoked', async () => {
    const { repo, setTmuxWindow, clearTmuxWindowIfMatches } = makeMultiTaskRepo({ 1: 'task-1-gen1' });
    const paneEnvService = makePaneEnvServiceSpy();
    const order: string[] = [];
    let currentWindowName = 'task-1-gen1';
    let currentTarget = 'session:task-1-gen1';
    const resolveWindows = vi.fn(() => [
      { taskId: 1, windowName: currentWindowName, target: currentTarget, onDestroyed: () => order.push('session-kill-cleanup') },
    ]);

    // The respawn acquires task 1's rotation lock FIRST (nothing else is
    // queued yet) and lands a brand-new window generation before the session
    // kill is even issued below.
    const respawnPromise = runExclusiveForTask(1, async () => {
      order.push('respawn-start');
      setTmuxWindow(1, 'task-1-gen2');
      currentWindowName = 'task-1-gen2';
      currentTarget = 'session:task-1-gen2';
      order.push('respawn-done');
      return { stdout: '', stderr: '', code: 0 };
    });

    const killSession = vi.fn(async () => {
      order.push('session-kill-run');
      return { stdout: '', stderr: '', code: 0 };
    });
    const { outcome, handledTargets } = await destroyPrimaryTaskWindowsForSessionKill(
      resolveWindows,
      repo,
      paneEnvService,
      'window_killed_via_session_delete',
      killSession,
    );
    await respawnPromise;

    expect(outcome.success).toBe(true);
    expect(order).toEqual(['respawn-start', 'respawn-done', 'session-kill-run', 'session-kill-cleanup']);
    // resolveWindows is called more than once: once (at least) before the
    // lock to pick a lock target, and again inside the lock right before the
    // kill — this second call is what observes the respawn's new generation.
    expect(resolveWindows.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The critical assertion: the reread used the respawn's NEW generation
    // (task-1-gen2), not the stale pre-lock snapshot — so it correctly
    // matches the task's actual current window and revokes it.
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(1, 'task-1-gen2');
    expect(paneEnvService.revokeForDestroyedWindow).toHaveBeenCalledWith(1, 'window_killed_via_session_delete');
    expect(handledTargets).toEqual(new Set(['session:task-1-gen2']));
  });

  // The task-ID-SET-itself-stale case: not a window generation changing
  // under an unchanged task set (the two tests above), but a DIFFERENT task
  // entering the session's window list between the initial (pre-lock) read
  // and the re-read taken once the lock is actually held. The initial read
  // can only pick which tasks' queues to wait on — this asserts that a
  // mismatch there triggers a lock release + reacquire against the WIDER
  // set, rather than proceeding to kill with a stale task set.
  it('reacquires the lock against the WIDER task set when the reread finds a task the initial snapshot missed', async () => {
    const { repo, clearTmuxWindowIfMatches } = makeMultiTaskRepo({ 1: 'task-1', 2: 'task-2' });
    const paneEnvService = makePaneEnvServiceSpy();
    const onDestroyed1 = vi.fn();
    const onDestroyed2 = vi.fn();
    let call = 0;
    // First call (before any lock is held): only task 1 is visible. Every
    // call from the second onward (i.e. every call made once inside a lock
    // acquisition): task 2 has since appeared too, and stays visible.
    const resolveWindows = vi.fn(() => {
      call += 1;
      const windows = [{ taskId: 1, windowName: 'task-1', target: 'session:task-1', onDestroyed: onDestroyed1 }];
      if (call >= 2) {
        windows.push({ taskId: 2, windowName: 'task-2', target: 'session:task-2', onDestroyed: onDestroyed2 });
      }
      return windows;
    });
    const killSession = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));

    const { outcome, handledTargets } = await destroyPrimaryTaskWindowsForSessionKill(
      resolveWindows,
      repo,
      paneEnvService,
      'window_killed_via_session_delete',
      killSession,
    );

    expect(outcome.success).toBe(true);
    // killSession only ran once — the mismatched first re-read triggered a
    // retry (re-acquire against [1, 2]) INSTEAD of proceeding to kill with
    // just task 1 locked.
    expect(killSession).toHaveBeenCalledTimes(1);
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(1, 'task-1');
    expect(clearTmuxWindowIfMatches).toHaveBeenCalledWith(2, 'task-2');
    expect(onDestroyed1).toHaveBeenCalledTimes(1);
    expect(onDestroyed2).toHaveBeenCalledTimes(1);
    expect(handledTargets).toEqual(new Set(['session:task-1', 'session:task-2']));
  });
});
