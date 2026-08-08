import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sessionsRoutes from './sessions';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { TmuxClient } from '../TmuxClient';
import type { SqliteWindowRepository } from '../../windows/SqliteWindowRepository';
import { resolveKillOutcome } from '../killOutcome';

function makeServerRepo(srv: ServerConfig): IServerRepository {
  return {
    findByName: (name: string) => (name === srv.name ? srv : undefined),
  } as unknown as IServerRepository;
}

type FakeWindowRepo = SqliteWindowRepository & {
  removeByServerAndTarget: ReturnType<typeof vi.fn>;
  findByServerAndTarget: ReturnType<typeof vi.fn>;
  findByServerAndSession: ReturnType<typeof vi.fn>;
};

function makeWindowRepo(): FakeWindowRepo {
  return {
    removeByServerAndTarget: vi.fn(() => 0),
    // Undefined by default (no task-owned window row found) — the DELETE
    // handler looks this up before killing to decide whether to revoke a
    // task token (Issue #28 third-party review finding); most of this
    // file's existing tests aren't about task windows at all.
    findByServerAndTarget: vi.fn(() => undefined),
    // Empty by default — the DELETE session handler looks this up before
    // killing to resolve which windows (task-owned or not) the session
    // held (Issue #28 third-party review finding 4); most existing tests
    // aren't about session-wide delete at all.
    findByServerAndSession: vi.fn(() => []),
  } as unknown as FakeWindowRepo;
}

/**
 * Fake `destroyPrimaryTaskWindow` that mirrors the real function's contract
 * (kill → on success: run `onDestroyed` → resolve a `KillOutcome`) without
 * the per-task lock or token-repo plumbing — these route-level tests only
 * need to confirm the ROUTE calls it with the right (taskId, windowName,
 * reason) and reacts correctly to its resolved outcome; the lock/reread
 * behavior itself is covered by TaskWindowDestruction.test.ts.
 */
function makeDestroyPrimaryTaskWindow() {
  return vi.fn(async (
    _taskId: number,
    _windowName: string,
    _serverName: string,
    _target: string,
    _reason: string,
    kill: () => Promise<{ stdout: string; stderr: string; code: number }>,
    onDestroyed: () => void,
  ) => {
    // Reuses the real `resolveKillOutcome` (not a bare `code === 0` check) so
    // this fake's "already gone" handling matches production exactly.
    const outcome = await resolveKillOutcome(kill());
    if (outcome.success) onDestroyed();
    return outcome;
  });
}

/**
 * Fake `destroySessionWindows` that mirrors
 * `destroyPrimaryTaskWindowsForSessionKill`'s contract (re-resolve → kill
 * session → on success: run every window's `onDestroyed` → resolve a
 * `KillOutcome` + `handledTargets`) without the multi-task lock or the
 * stale-snapshot retry loop — these route-level tests only need to confirm
 * the ROUTE calls it with a working `resolveWindows`/serverName/reason and
 * reacts correctly to its resolved result; the lock/reread/retry behavior
 * itself is covered by TaskWindowDestruction.test.ts.
 */
function makeDestroySessionWindows() {
  return vi.fn(async (
    resolveWindows: () => Array<{ taskId: number; windowName: string; target: string; onDestroyed: () => void }>,
    _serverName: string,
    _reason: string,
    killSession: () => Promise<{ stdout: string; stderr: string; code: number }>,
  ) => {
    const windows = resolveWindows();
    const outcome = await resolveKillOutcome(killSession());
    const handledTargets = new Set<string>();
    if (outcome.success) {
      for (const w of windows) {
        w.onDestroyed();
        handledTargets.add(w.target);
      }
    }
    return { outcome, handledTargets };
  });
}

async function buildApp(opts: {
  tmux: Partial<TmuxClient>;
  windowRepo: SqliteWindowRepository;
  destroyPrimaryTaskWindow?: ReturnType<typeof makeDestroyPrimaryTaskWindow>;
  destroySessionWindows?: ReturnType<typeof makeDestroySessionWindows>;
  buildSecondaryWindowEnv?: ReturnType<typeof vi.fn>;
}): Promise<FastifyInstance> {
  const srv: ServerConfig = { name: 'srv1', type: 'local' } as ServerConfig;
  const app = Fastify();
  await app.register(sessionsRoutes, {
    serverRepo: makeServerRepo(srv),
    tmux: opts.tmux as TmuxClient,
    windowRepo: opts.windowRepo,
    destroyPrimaryTaskWindow: opts.destroyPrimaryTaskWindow,
    destroySessionWindows: opts.destroySessionWindows,
    buildSecondaryWindowEnv: opts.buildSecondaryWindowEnv as ((taskId: number, server: ServerConfig) => Record<string, string>) | undefined,
  });
  await app.ready();
  return app;
}

describe('DELETE /api/servers/:name/windows/:target', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 and cleans up the DB row when the window is already gone (kill-window: "can\'t find window")', async () => {
    const windowRepo = makeWindowRepo();
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: "can't find window: 2", code: 1 })),
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, identity: null });
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:2');
  });

  it('returns 200 and cleans up the DB row when kill-window throws (local transport, window already gone)', async () => {
    const windowRepo = makeWindowRepo();
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      killWindow: vi.fn(async () => { throw new Error("Command failed: tmux kill-window -t session:2\ncan't find window: 2"); }),
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

    expect(res.statusCode).toBe(200);
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:2');
  });

  it('returns 500 and does not clean up the DB row when kill-window fails for another reason', async () => {
    const windowRepo = makeWindowRepo();
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => ({ sessionName: 'session', windowIndex: 2, windowName: 'win--abcd' })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 })),
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

    expect(res.statusCode).toBe(500);
    expect(windowRepo.removeByServerAndTarget).not.toHaveBeenCalled();
  });

  it('cleans up both index-form and name-form DB rows when the target uses an index and identity resolves', async () => {
    const windowRepo = makeWindowRepo();
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => ({ sessionName: 'session', windowIndex: 2, windowName: 'win--abcd' })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, identity: { sessionName: 'session', windowIndex: 2, windowName: 'win--abcd' } });
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:2');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:win--abcd');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledTimes(3);
  });

  // Issue #28 third-party review finding: destroying a task-owned window
  // through this generic kill route must revoke that task's token
  // generation the same way the task-execution rollback paths do — a
  // destroyed window can never again be resumed onto.
  describe('task token revocation on window destroy (Issue #28 third-party review)', () => {
    it('revokes the owning task token when the killed window belongs to a task', async () => {
      const windowRepo = makeWindowRepo();
      (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2', isPrimary: true,
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      };
      const destroyPrimaryTaskWindow = makeDestroyPrimaryTaskWindow();
      app = await buildApp({ tmux, windowRepo, destroyPrimaryTaskWindow });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(200);
      expect(destroyPrimaryTaskWindow).toHaveBeenCalledWith(42, '2', 'srv1', 'session:2', 'window_killed_via_sessions_route', expect.any(Function), expect.any(Function));
    });

    it('does NOT revoke when the killed window is project-owned (not a task window)', async () => {
      const windowRepo = makeWindowRepo();
      (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 5, ownerType: 'project', taskId: null, projectId: 1, serverName: 'srv1', tmuxTarget: 'session:2',
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      };
      const destroyPrimaryTaskWindow = makeDestroyPrimaryTaskWindow();
      app = await buildApp({ tmux, windowRepo, destroyPrimaryTaskWindow });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(200);
      expect(destroyPrimaryTaskWindow).not.toHaveBeenCalled();
    });

    // Issue #28 multi-window token collision fix: a SECONDARY task-owned
    // window (added via POST /api/tasks/:id/windows, isPrimary: false) must
    // not revoke the task's token either — that token is bound one-to-one to
    // the task's PRIMARY worker window, and revoking it here would 401 that
    // still-live primary pane.
    it('does NOT revoke when the killed window is a SECONDARY task window (not the primary worker window)', async () => {
      const windowRepo = makeWindowRepo();
      (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2', isPrimary: false,
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      };
      const destroyPrimaryTaskWindow = makeDestroyPrimaryTaskWindow();
      app = await buildApp({ tmux, windowRepo, destroyPrimaryTaskWindow });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(200);
      expect(destroyPrimaryTaskWindow).not.toHaveBeenCalled();
    });

    it('does NOT revoke when kill-window fails for a reason other than "already gone" (window may still be alive)', async () => {
      const windowRepo = makeWindowRepo();
      (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2', isPrimary: true,
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 })),
      };
      const destroyPrimaryTaskWindow = makeDestroyPrimaryTaskWindow();
      app = await buildApp({ tmux, windowRepo, destroyPrimaryTaskWindow });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      // The kill itself now runs INSIDE destroyPrimaryTaskWindow (Issue #28
      // third-party review, second round — kill+revoke share one per-task
      // lock), so the route DOES call it here; it's the fake's own
      // `resolveKillOutcome`-backed outcome (success: false) that keeps
      // `onDestroyed` (and, in production, the revoke) from firing.
      expect(res.statusCode).toBe(500);
      expect(destroyPrimaryTaskWindow).toHaveBeenCalledWith(42, '2', 'srv1', 'session:2', 'window_killed_via_sessions_route', expect.any(Function), expect.any(Function));
    });

    it('still revokes when kill-window reports the window already gone ("can\'t find")', async () => {
      const windowRepo = makeWindowRepo();
      (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2', isPrimary: true,
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: "can't find window: 2", code: 1 })),
      };
      const destroyPrimaryTaskWindow = makeDestroyPrimaryTaskWindow();
      app = await buildApp({ tmux, windowRepo, destroyPrimaryTaskWindow });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(200);
      expect(destroyPrimaryTaskWindow).toHaveBeenCalledWith(42, '2', 'srv1', 'session:2', 'window_killed_via_sessions_route', expect.any(Function), expect.any(Function));
    });
  });
});

// Issue #28 third-party review finding 4: deleting a whole session used to
// revoke NO task tokens at all (only the single-window DELETE route above
// did) and never cleaned up the `windows` rows it held. This exercises the
// fixed handler: it resolves the session's windows BEFORE killing, then —
// once the kill is confirmed (success or "already gone") — cleans up every
// window row and revokes each task-owned window via the SAME
// onTaskWindowDestroyed callback the single-window route uses.
describe('DELETE /api/servers/:name/sessions/:session', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('revokes every PRIMARY task-owned window in the session, cleans up all window rows, and does not revoke a secondary task window (Issue #28 multi-window token collision fix)', async () => {
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42', isPrimary: true },
      { id: 2, ownerType: 'task', taskId: 43, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-43', isPrimary: true },
      { id: 3, ownerType: 'project', taskId: null, projectId: 1, serverName: 'srv1', tmuxTarget: 'session:extra', isPrimary: false },
      { id: 4, ownerType: 'task', taskId: 44, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-44-secondary', isPrimary: false },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    const destroySessionWindows = makeDestroySessionWindows();
    app = await buildApp({ tmux, windowRepo, destroySessionWindows });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    // Issue #28 third-party review, D-track fix 1: the kill and BOTH primary
    // task windows' reread/revoke run inside ONE call — locked against both
    // task IDs at once — never per-window after an unlocked kill.
    expect(destroySessionWindows).toHaveBeenCalledTimes(1);
    const [resolveWindows] = destroySessionWindows.mock.calls[0]!;
    expect(resolveWindows()).toEqual([
      { taskId: 42, windowName: 'task-42', target: 'session:task-42', onDestroyed: expect.any(Function) },
      { taskId: 43, windowName: 'task-43', target: 'session:task-43', onDestroyed: expect.any(Function) },
    ]);
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-42');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-43');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:extra');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-44-secondary');
  });

  it('does not revoke or clean up when kill-session fails for a reason other than "already gone"', async () => {
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42', isPrimary: true },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 })),
    };
    const destroySessionWindows = makeDestroySessionWindows();
    app = await buildApp({ tmux, windowRepo, destroySessionWindows });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(500);
    // The batched kill still runs (it's INSIDE destroySessionWindows now),
    // but its unsuccessful outcome means no window's onDestroyed fires.
    expect(destroySessionWindows).toHaveBeenCalledTimes(1);
    expect(windowRepo.removeByServerAndTarget).not.toHaveBeenCalled();
  });

  it('still revokes and cleans up when kill-session reports the session already gone', async () => {
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42', isPrimary: true },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: "can't find session: session", code: 1 })),
    };
    const destroySessionWindows = makeDestroySessionWindows();
    app = await buildApp({ tmux, windowRepo, destroySessionWindows });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    expect(destroySessionWindows).toHaveBeenCalledWith(
      expect.any(Function),
      'srv1',
      'window_killed_via_session_delete',
      expect.any(Function),
    );
    const [resolveWindows] = destroySessionWindows.mock.calls[0]!;
    expect(resolveWindows()).toEqual([{ taskId: 42, windowName: 'task-42', target: 'session:task-42', onDestroyed: expect.any(Function) }]);
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-42');
  });

  it('does not revoke anything when the session has no windows at all', async () => {
    const windowRepo = makeWindowRepo();
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    const destroySessionWindows = makeDestroySessionWindows();
    app = await buildApp({ tmux, windowRepo, destroySessionWindows });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    expect(destroySessionWindows).toHaveBeenCalledWith(expect.any(Function), 'srv1', 'window_killed_via_session_delete', expect.any(Function));
    const [resolveWindows] = destroySessionWindows.mock.calls[0]!;
    expect(resolveWindows()).toEqual([]);
    expect(windowRepo.removeByServerAndTarget).not.toHaveBeenCalled();
  });

  // Issue #28 third-party review, D-track fix 3: when no destroySessionWindows
  // callback is wired at all (e.g. a minimal test/dev setup), every window
  // row the session held — including a PRIMARY task window's — must still be
  // cleaned up unconditionally on a confirmed kill. The previous shape
  // (`opts.destroyPrimaryTaskWindow?.(...)` inside an `if` branch that only
  // falls to the row-cleanup `else` for NON-primary-task windows) silently
  // left a primary task window's row behind whenever the optional callback
  // was absent.
  it('falls back to a plain kill + full row cleanup (including primary task windows) when destroySessionWindows is not wired', async () => {
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42', isPrimary: true },
      { id: 2, ownerType: 'project', taskId: null, projectId: 1, serverName: 'srv1', tmuxTarget: 'session:extra', isPrimary: false },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    // No destroySessionWindows passed at all.
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-42');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:extra');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledTimes(2);
  });
});

// Issue #28 third-party review finding 1: the generic "add pane" route
// previously always split with no extraEnv at all — a task's primary window
// leaked its running pane's env via tmux SESSION inheritance instead of ever
// getting a properly-scoped extraEnv, and a leftover AZITO_UI_TOKEN on an
// older session would flow straight into the new pane.
describe('POST /api/servers/:name/sessions/:session/windows/:window/panes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('rejects with 409 when the target is a task\'s PRIMARY window (no way to hand the new pane the live, unrotated token)', async () => {
    const windowRepo = makeWindowRepo();
    (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2', isPrimary: true,
    });
    const splitPane = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      splitPane,
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows/2/panes' });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('primary_task_window_pane_add_unsupported');
    expect(splitPane).not.toHaveBeenCalled();
  });

  it('splits with the masked secondary-window env when the target is a SECONDARY task window', async () => {
    const windowRepo = makeWindowRepo();
    (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2', isPrimary: false,
    });
    const splitPane = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      splitPane,
    };
    const maskedEnv = { AZITO_TASK_ID: '42', AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' };
    const buildSecondaryWindowEnv = vi.fn(() => maskedEnv);
    app = await buildApp({ tmux, windowRepo, buildSecondaryWindowEnv });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows/2/panes' });

    expect(res.statusCode).toBe(200);
    expect(buildSecondaryWindowEnv).toHaveBeenCalledWith(42, expect.objectContaining({ name: 'srv1' }));
    expect(splitPane).toHaveBeenCalledWith(expect.objectContaining({ name: 'srv1' }), 'session:2', 'v', maskedEnv);
  });

  it('splits with the legacy uiTokenEnv() for a non-task window', async () => {
    const windowRepo = makeWindowRepo();
    const splitPane = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const uiTokenEnv = vi.fn(() => ({ AZITO_UI_TOKEN: 'legacy-ui-token' }));
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      splitPane,
      uiTokenEnv,
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows/2/panes' });

    expect(res.statusCode).toBe(200);
    expect(splitPane).toHaveBeenCalledWith(expect.objectContaining({ name: 'srv1' }), 'session:2', 'v', { AZITO_UI_TOKEN: 'legacy-ui-token' });
  });
});
