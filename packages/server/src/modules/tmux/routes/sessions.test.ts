import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sessionsRoutes, { invalidateSessionCache, type SessionsRouteOptions } from './sessions';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { TmuxClient } from '../TmuxClient';
import type { SqliteWindowRepository } from '../../windows/SqliteWindowRepository';
import { resolveKillOutcome } from '../killOutcome';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import type { IMuxClient } from '../IMuxClient';
import { MuxDriverUnavailableError, MuxOperationUnsupportedError } from '../MuxCapabilityError';
import { TmuxClient as TmuxClientImpl } from '../TmuxClient';
import { mapAppError } from '../../../app/mapAppError';
import { AgentUnreachableError } from '../../servers/transport/AgentUnreachableError';

function makeServerRepo(srv: ServerConfig): IServerRepository {
  return {
    findByName: (name: string) => (name === srv.name ? srv : undefined),
  } as unknown as IServerRepository;
}

type FakeWindowRepo = SqliteWindowRepository & {
  removeByServerAndTarget: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  findByServerAndTarget: ReturnType<typeof vi.fn>;
  findByServerAndRef: ReturnType<typeof vi.fn>;
  findByServerAndSession: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
};

function makeWindowRepo(): FakeWindowRepo {
  return {
    removeByServerAndTarget: vi.fn(() => 0),
    // Issue #28 third-party review, batch-2 finding: the session-delete
    // route's "remaining rows" cleanup now deletes by row `id` (captured in
    // a pre-kill snapshot) instead of re-fetching-and-matching by `target`
    // after the kill, since tmux window targets get reused for new windows.
    remove: vi.fn(),
    // Undefined by default (no task-owned window row found) — the DELETE
    // handler looks this up before killing to decide whether to revoke a
    // task token (Issue #28 third-party review finding); most of this
    // file's existing tests aren't about task windows at all.
    findByServerAndTarget: vi.fn(() => undefined),
    findByServerAndRef: vi.fn(() => undefined),
    // Empty by default — the DELETE session handler looks this up before
    // killing to resolve which windows (task-owned or not) the session
    // held (Issue #28 third-party review finding 4); most existing tests
    // aren't about session-wide delete at all.
    findByServerAndSession: vi.fn(() => []),
    // Issue #28 third-party review, D-track fix 3: the DELETE session
    // handler reads this to bound its post-kill safety-net cleanup — see
    // `killStartedAt`'s doc comment in sessions.ts. A fixed value is fine
    // for every existing test: none of the fake window rows below carry a
    // `createdAt`, so the `<=` comparison in that safety net always
    // resolves to `false` (undefined is never `<=` anything) and the net
    // never fires for them.
    now: vi.fn(() => '2026-01-01 00:00:00'),
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
  // Issue #29 review (5th pass), Critical finding 1: lets tests exercise the
  // manual session/window/pane creation routes against an isolated server —
  // these routes now call `tmux.uiTokenEnvForServer(srv)` instead of the
  // server-blind `tmux.uiTokenEnv()`, so `srv.isolationIntent` has to be
  // controllable per test.
  isolationIntent?: boolean;
  // Issue #29 review, Important finding 2: lets tests supply their own
  // serverRepo (e.g. one that tracks call count/order, or hands back a
  // DIFFERENT row on a later call to simulate a concurrent PUT
  // /api/servers/:name landing) instead of the fixed single-row fake above —
  // used to confirm the create-session/window/pane routes resolve the
  // server row exactly once, INSIDE the lock, rather than once before it and
  // again inside.
  serverRepo?: IServerRepository;
  resourceGuard?: { check: ReturnType<typeof vi.fn> };
}): Promise<FastifyInstance> {
  const srv: ServerConfig = { name: 'srv1', type: 'local', isolationIntent: opts.isolationIntent ?? false } as ServerConfig;
  const app = Fastify();
  await app.register(sessionsRoutes, {
    serverRepo: opts.serverRepo ?? makeServerRepo(srv),
    tmux: opts.tmux as TmuxClient,
    uiToken: 'test-token',
    windowRepo: opts.windowRepo,
    destroyPrimaryTaskWindow: opts.destroyPrimaryTaskWindow,
    destroySessionWindows: opts.destroySessionWindows,
    buildSecondaryWindowEnv: opts.buildSecondaryWindowEnv as ((taskId: number, server: ServerConfig) => Record<string, string>) | undefined,
    resourceGuard: opts.resourceGuard as unknown as SessionsRouteOptions['resourceGuard'],
    // Issue #29 review (6th pass), Important finding 3: a fresh instance per
    // app is fine for this file's route-level tests (none exercise
    // cross-route serialization against servers/routes.ts).
    serverIsolationMutex: new KeyedMutex(),
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
      closeWindow: vi.fn(async () => ({ stdout: '', stderr: "can't find window: 2", code: 1 })),
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
      closeWindow: vi.fn(async () => { throw new Error("Command failed: tmux kill-window -t session:2\ncan't find window: 2"); }),
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
      closeWindow: vi.fn(async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 })),
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
      closeWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, identity: { sessionName: 'session', windowIndex: 2, windowName: 'win--abcd' } });
    // With the MuxRef-based lookup, findByServerAndRef returns undefined so
    // cleanup falls back to removeByServerAndTarget with the raw target.
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:2');
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
        closeWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
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
        closeWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
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
        closeWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
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
        closeWindow: vi.fn(async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 })),
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
        closeWindow: vi.fn(async () => ({ stdout: '', stderr: "can't find window: 2", code: 1 })),
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
    // The non-primary rows (project window + secondary task window) are
    // NOT handled by destroySessionWindows, so the route's own cleanup
    // deletes them by their captured row id, not by target.
    expect(windowRepo.remove).toHaveBeenCalledWith(3);
    expect(windowRepo.remove).toHaveBeenCalledWith(4);
    expect(windowRepo.remove).toHaveBeenCalledTimes(2);
  });

  it('does not delete a row created after the pre-kill snapshot even if it reuses a killed window\'s target (Issue #28 third-party review, batch-2 fix)', async () => {
    const windowRepo = makeWindowRepo();
    // Pre-kill snapshot: one project window at "session:extra" (row id 3).
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 3, ownerType: 'project', taskId: null, projectId: 1, serverName: 'srv1', tmuxTarget: 'session:extra', isPrimary: false },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    const destroySessionWindows = makeDestroySessionWindows();
    app = await buildApp({ tmux, windowRepo, destroySessionWindows });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    // Only the row id captured in the pre-kill snapshot is deleted — never a
    // target-based delete, which could hit a brand-new row (a different id)
    // that reused the same "session:extra" target after the kill.
    expect(windowRepo.remove).toHaveBeenCalledWith(3);
    expect(windowRepo.remove).toHaveBeenCalledTimes(1);
    expect(windowRepo.removeByServerAndTarget).not.toHaveBeenCalledWith('srv1', 'session:extra');
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

  // Issue #28 third-party review, D-track fix 3: a secondary/project window
  // row can be INSERTed between the pre-kill snapshot and the kill actually
  // completing (secondary-window creation isn't serialized by the per-task
  // lock). The post-kill safety net must catch it — it was killed in tmux
  // right along with everything else, but the pre-kill snapshot never saw
  // it, so the by-id cleanup alone would leave its row behind forever.
  it('cleans up a secondary window row created in the gap between the pre-kill snapshot and kill completion (D-track fix 3)', async () => {
    const windowRepo = makeWindowRepo();
    (windowRepo.now as ReturnType<typeof vi.fn>).mockReturnValue('2026-01-01 00:00:05');
    // First call (the pre-kill snapshot, taken inside destroySessionWindows'
    // resolvePrimaryTaskWindows) sees only the primary task window. The
    // SECOND call is the route's own post-kill safety-net re-query — it
    // finds an extra row (id 9) that appeared in the gap, created BEFORE
    // killStartedAt, so it must be cleaned up too.
    windowRepo.findByServerAndSession
      .mockReturnValueOnce([
        { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42', isPrimary: true, createdAt: '2026-01-01 00:00:00' },
      ])
      .mockReturnValueOnce([
        { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42', isPrimary: true, createdAt: '2026-01-01 00:00:00' },
        { id: 9, ownerType: 'project', taskId: null, projectId: 3, serverName: 'srv1', tmuxTarget: 'session:extra-late', isPrimary: false, createdAt: '2026-01-01 00:00:02' },
      ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    const destroySessionWindows = makeDestroySessionWindows();
    app = await buildApp({ tmux, windowRepo, destroySessionWindows });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    // The primary task window is handled via destroySessionWindows/removeByServerAndTarget.
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-42');
    // The late-arriving row (created before killStartedAt) is cleaned up by
    // the post-kill safety net, by id.
    expect(windowRepo.remove).toHaveBeenCalledWith(9);
  });

  // The mirror case: a row created AFTER the kill (e.g. a brand-new session
  // that reused the same session name moments later) must survive the
  // safety net — its created_at is after killStartedAt.
  it('does not delete a row created AFTER killStartedAt (a brand-new session reusing the same name)', async () => {
    const windowRepo = makeWindowRepo();
    (windowRepo.now as ReturnType<typeof vi.fn>).mockReturnValue('2026-01-01 00:00:05');
    windowRepo.findByServerAndSession
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        { id: 10, ownerType: 'project', taskId: null, projectId: 3, serverName: 'srv1', tmuxTarget: 'session:brand-new', isPrimary: false, createdAt: '2026-01-01 00:00:09' },
      ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    const destroySessionWindows = makeDestroySessionWindows();
    app = await buildApp({ tmux, windowRepo, destroySessionWindows });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    expect(windowRepo.remove).not.toHaveBeenCalledWith(10);
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
    expect(windowRepo.remove).toHaveBeenCalledWith(1);
    expect(windowRepo.remove).toHaveBeenCalledWith(2);
    expect(windowRepo.remove).toHaveBeenCalledTimes(2);
    expect(windowRepo.removeByServerAndTarget).not.toHaveBeenCalled();
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
      resolveRef: vi.fn(async () => null),
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
      resolveRef: vi.fn(async () => null),
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

  it('splits with the legacy uiTokenEnvForServer() for a non-task window', async () => {
    const windowRepo = makeWindowRepo();
    const splitPane = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      resolveRef: vi.fn(async () => null),
      splitPane,
    };
    app = await buildApp({ tmux, windowRepo });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows/2/panes' });

    expect(res.statusCode).toBe(200);
    expect(splitPane).toHaveBeenCalledWith(expect.objectContaining({ name: 'srv1' }), 'session:2', 'v', { AZITO_UI_TOKEN: 'test-token' });
  });

  // Issue #29 review (5th pass), Critical finding 1: this generic "add pane"
  // route must never hand an isolated server's non-task window the hub's UI
  // token — uiTokenEnvForServer(srv) is the single choke point that masks
  // it, so this confirms the route actually calls THAT method (not the
  // server-blind uiTokenEnv()) and forwards whatever it returns unchanged.
  it('withholds the UI token when splitting a non-task window on an isolation_intent server', async () => {
    const windowRepo = makeWindowRepo();
    const splitPane = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      resolveRef: vi.fn(async () => null),
      splitPane,
    };
    app = await buildApp({ tmux, windowRepo, isolationIntent: true });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows/2/panes' });

    expect(res.statusCode).toBe(200);
    expect(splitPane).toHaveBeenCalledWith(expect.objectContaining({ name: 'srv1' }), 'session:2', 'v', { AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' });
  });

  // Issue #29 review, Important finding 2: identity resolution and the
  // primary-task-window classification (which decides the 409) must run
  // against the SAME server row splitPane eventually uses — resolved exactly
  // once, INSIDE the lock. A pre-lock classification let a concurrent PUT
  // /api/servers/:name commit before the lock was acquired, so the
  // classification ran against a server row the tmux call (inside the lock,
  // on a re-fetched row) no longer targeted.
  it('resolves the server exactly once, inside the lock, and resolves identity/splitPane against that row', async () => {
    const windowRepo = makeWindowRepo();
    const srvV2: ServerConfig = { name: 'srv1', type: 'local', isolationIntent: false, host: 'host-v2' } as ServerConfig;
    const findByName = vi.fn(() => srvV2);
    const serverRepo = { findByName } as unknown as IServerRepository;
    const resolveRef = vi.fn(async () => null);
    const splitPane = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const tmux: Partial<TmuxClient> = {
      getWindowIdentity: vi.fn(async () => null),
      resolveRef,
      splitPane,
    };
    app = await buildApp({ tmux, windowRepo, serverRepo });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows/2/panes' });

    expect(res.statusCode).toBe(200);
    expect(findByName).toHaveBeenCalledTimes(1);
    expect(resolveRef).toHaveBeenCalledWith(srvV2, 'session:2');
    expect(splitPane).toHaveBeenCalledWith(srvV2, 'session:2', 'v', expect.anything());
  });
});

describe('POST /api/servers/:name/sessions', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // Issue #29 review (5th pass), Critical finding 1: manual "New Session"
  // creation previously injected the hub's AZITO_UI_TOKEN into every
  // server unconditionally via tmux.uiTokenEnv() — including a server
  // declared isolation_intent=1, which is meant to hold no credentials.
  it('withholds the UI token when creating a session on an isolation_intent server', async () => {
    const windowRepo = makeWindowRepo();
    const createSession = vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'win' }));
    const tmux: Partial<TmuxClient> = {
      createSession,
    };
    app = await buildApp({ tmux, windowRepo, isolationIntent: true });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions', payload: { name: 'newsess' } });

    expect(res.statusCode).toBe(200);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'srv1' }),
      'newsess',
      expect.objectContaining({ extraEnv: { AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' } }),
    );
  });

  it('injects the legacy UI token when the server is not isolated', async () => {
    const windowRepo = makeWindowRepo();
    const createSession = vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'win' }));
    const tmux: Partial<TmuxClient> = {
      createSession,
    };
    app = await buildApp({ tmux, windowRepo, isolationIntent: false });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions', payload: { name: 'newsess' } });

    expect(res.statusCode).toBe(200);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'srv1' }),
      'newsess',
      expect.objectContaining({ extraEnv: { AZITO_UI_TOKEN: 'test-token' } }),
    );
  });

  // Issue #29 review, Important finding 2: the resource check and the tmux
  // create call must both act on the SAME server row, resolved exactly once
  // INSIDE the per-server-name lock — a pre-lock resourceGuard check let a
  // concurrent PUT /api/servers/:name commit before the lock was acquired,
  // so the check ran against a host the create call (inside the lock, on a
  // re-fetched row) no longer targeted. `findByName` is asserted to be
  // called exactly once, and resourceGuard.check to receive that same row.
  it('resolves the server exactly once, inside the lock, and runs the resource check against that row', async () => {
    const windowRepo = makeWindowRepo();
    const srvV2: ServerConfig = { name: 'srv1', type: 'local', isolationIntent: false, host: 'host-v2' } as ServerConfig;
    const findByName = vi.fn(() => srvV2);
    const serverRepo = { findByName } as unknown as IServerRepository;
    const resourceGuardCheck = vi.fn(async () => ({ ok: true }));
    const createSession = vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'win' }));
    const tmux: Partial<TmuxClient> = {
      createSession,
    };
    app = await buildApp({ tmux, windowRepo, serverRepo, resourceGuard: { check: resourceGuardCheck } });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions', payload: { name: 'newsess' } });

    expect(res.statusCode).toBe(200);
    expect(findByName).toHaveBeenCalledTimes(1);
    expect(resourceGuardCheck).toHaveBeenCalledWith(srvV2);
    expect(createSession).toHaveBeenCalledWith(srvV2, 'newsess', expect.anything());
  });
});

describe('POST /api/servers/:name/sessions/:session/windows', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  // Issue #29 review (5th pass), Critical finding 1: same masking gap as
  // POST /sessions above, for the "New Window" manual-creation route.
  it('withholds the UI token when creating a window on an isolation_intent server', async () => {
    const windowRepo = makeWindowRepo();
    const createWindow = vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'win' }));
    const tmux: Partial<TmuxClient> = {
      createWindow,
    };
    app = await buildApp({ tmux, windowRepo, isolationIntent: true });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'srv1' }),
      'session',
      undefined,
      expect.objectContaining({ extraEnv: { AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' } }),
    );
  });

  // Issue #29 review, Important finding 2: same single-fetch/inside-the-lock
  // guarantee as the analogous POST /sessions test above.
  it('resolves the server exactly once, inside the lock, and runs the resource check against that row', async () => {
    const windowRepo = makeWindowRepo();
    const srvV2: ServerConfig = { name: 'srv1', type: 'local', isolationIntent: false, host: 'host-v2' } as ServerConfig;
    const findByName = vi.fn(() => srvV2);
    const serverRepo = { findByName } as unknown as IServerRepository;
    const resourceGuardCheck = vi.fn(async () => ({ ok: true }));
    const createWindow = vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'win' }));
    const tmux: Partial<TmuxClient> = {
      createWindow,
    };
    app = await buildApp({ tmux, windowRepo, serverRepo, resourceGuard: { check: resourceGuardCheck } });

    const res = await app.inject({ method: 'POST', url: '/api/servers/srv1/sessions/session/windows', payload: {} });

    expect(res.statusCode).toBe(200);
    expect(findByName).toHaveBeenCalledTimes(1);
    expect(resourceGuardCheck).toHaveBeenCalledWith(srvV2);
    expect(createWindow).toHaveBeenCalledWith(srvV2, 'session', undefined, expect.anything());
  });
});

describe('GET /api/servers/:name/sessions on a misao server', () => {
  const misaoServer = { name: 'misao1', type: 'local', muxRuntime: 'misao' } as ServerConfig;
  const misaoRef = { kind: 'misao', workspace: 'ws-a', window: 'w_01' } as const;
  const workspaces = [{
    name: 'ws-a', windowCount: 1, attached: false, created: 0,
    windows: [{ index: 0, name: 'main', active: false, panes: [], activity: 0, ref: misaoRef }],
  }];
  let app: FastifyInstance;

  async function build(listWorkspaces: ReturnType<typeof vi.fn>, windowRepo = makeWindowRepo()) {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', { listWorkspaces } as unknown as IMuxClient);
    const tmux = { listSessions: vi.fn(), cleanupLinkedSessions: vi.fn() };
    app = Fastify();
    await app.register(sessionsRoutes, {
      serverRepo: makeServerRepo(misaoServer),
      tmux: tmux as unknown as TmuxClient,
      uiToken: 'test-token',
      windowRepo,
      muxDriverRegistry: registry,
      serverIsolationMutex: new KeyedMutex(),
    });
    await app.ready();
    return { tmux, windowRepo };
  }

  afterEach(async () => {
    invalidateSessionCache(misaoServer.name);
    await app.close();
  });

  it('lists through the driver, uses the driver-computed ref, and never touches tmux', async () => {
    const listWorkspaces = vi.fn(async () => workspaces);
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndRef.mockReturnValue({ id: 42 });
    const { tmux } = await build(listWorkspaces, windowRepo);

    const res = await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' });

    expect(res.statusCode).toBe(200);
    expect(res.json()[0].windows[0]).toMatchObject({ ref: JSON.stringify(misaoRef), windowId: 42 });
    expect(windowRepo.findByServerAndRef).toHaveBeenCalledWith('misao1', misaoRef);
    expect(tmux.listSessions).not.toHaveBeenCalled();
    expect(tmux.cleanupLinkedSessions).not.toHaveBeenCalled();
  });

  it('serves repeat reads from the cache until it is invalidated', async () => {
    const listWorkspaces = vi.fn(async () => workspaces);
    await build(listWorkspaces);

    await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' });
    await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' });
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    invalidateSessionCache('misao1');
    await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' });
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it('surfaces a daemon failure as a 500 instead of an empty list', async () => {
    await build(vi.fn(async () => { throw new Error('daemon unreachable'); }));

    const res = await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'daemon unreachable' });
  });

  it('answers 503 for a cached list once the driver is no longer available', async () => {
    let available = true;
    const listWorkspaces = vi.fn(async () => workspaces);
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', { listWorkspaces } as unknown as IMuxClient, () => (available ? { available: true } : { available: false, reason: 'daemon_unreachable' }));
    app = Fastify();
    app.setErrorHandler((err, _request, reply) => {
      if (err instanceof MuxDriverUnavailableError) return reply.status(503).send({ reason: err.reason });
      return reply.status(500).send({ error: 'unexpected' });
    });
    await app.register(sessionsRoutes, {
      serverRepo: makeServerRepo(misaoServer),
      tmux: {} as unknown as TmuxClient,
      uiToken: 'test-token',
      windowRepo: makeWindowRepo(),
      muxDriverRegistry: registry,
      serverIsolationMutex: new KeyedMutex(),
    });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' })).statusCode).toBe(200);
    available = false;
    const res = await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ reason: 'daemon_unreachable' });
    expect(listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('lets an unavailable driver reach the app error handler instead of the route 500', async () => {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    const listWorkspaces = vi.fn();
    registry.register('misao', { listWorkspaces } as unknown as IMuxClient, () => ({ available: false, reason: 'daemon_unreachable' }));
    app = Fastify();
    app.setErrorHandler((err, _request, reply) => {
      if (err instanceof MuxDriverUnavailableError) return reply.status(503).send({ reason: err.reason });
      return reply.status(500).send({ error: 'unexpected' });
    });
    await app.register(sessionsRoutes, {
      serverRepo: makeServerRepo(misaoServer),
      tmux: {} as unknown as TmuxClient,
      uiToken: 'test-token',
      muxDriverRegistry: registry,
      serverIsolationMutex: new KeyedMutex(),
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/servers/misao1/sessions' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ reason: 'daemon_unreachable' });
    expect(listWorkspaces).not.toHaveBeenCalled();
  });
});

describe('POST /api/servers/:name/mux/windows/:ref/panes/open', () => {
  const misaoServer = { name: 'misao1', type: 'local', muxRuntime: 'misao' } as ServerConfig;
  const windowId = 'w_0123456789ABCDEFGHJKMNPQRS';
  const misaoRef = { kind: 'misao', workspace: 'ws-a', window: windowId } as const;
  let app: FastifyInstance;
  const openPaneInWindow = vi.fn(async () => 'p_1');

  async function build(emit = vi.fn(), extra: { windowRepo?: SqliteWindowRepository; buildSecondaryWindowEnv?: (taskId: number, server: ServerConfig) => Record<string, string> } = {}) {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', { openPaneInWindow } as unknown as IMuxClient);
    app = Fastify();
    await app.register(sessionsRoutes, {
      serverRepo: makeServerRepo(misaoServer),
      tmux: {} as unknown as TmuxClient,
      uiToken: 'test-token',
      muxDriverRegistry: registry,
      notificationBus: { emit } as never,
      serverIsolationMutex: new KeyedMutex(),
      ...extra,
    });
    await app.ready();
    return emit;
  }

  function taskWindowRepo(isPrimary: boolean): SqliteWindowRepository {
    const windowRepo = makeWindowRepo();
    (windowRepo.findByServerAndRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'misao1', tmuxTarget: 'ws-a:main', isPrimary,
    });
    return windowRepo;
  }

  const url = `/api/servers/misao1/mux/windows/${encodeURIComponent(JSON.stringify(misaoRef))}/panes/open`;

  afterEach(async () => {
    openPaneInWindow.mockClear();
    await app.close();
  });

  it('opens a pane with the command and notifies sessions changed', async () => {
    const emit = await build();
    const res = await app.inject({ method: 'POST', url, payload: { command: 'claude' } });
    expect(res.statusCode).toBe(200);
    expect(openPaneInWindow).toHaveBeenCalledWith(misaoServer, misaoRef, expect.objectContaining({ command: 'claude' }));
    expect(emit).toHaveBeenCalledWith({ type: 'sessions:updated', payload: { serverName: 'misao1' } });
  });

  it('opens a shell-only pane without a body', async () => {
    await build();
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(openPaneInWindow).toHaveBeenCalledWith(misaoServer, misaoRef, expect.objectContaining({ command: undefined }));
  });

  it('rejects a blank command', async () => {
    await build();
    const res = await app.inject({ method: 'POST', url, payload: { command: '  ' } });
    expect(res.statusCode).toBe(400);
    expect(openPaneInWindow).not.toHaveBeenCalled();
  });

  it('gives a non-task window the manual-window env (operator UI token on a non-isolated server)', async () => {
    await build(vi.fn(), { windowRepo: makeWindowRepo() });
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(openPaneInWindow).toHaveBeenCalledWith(misaoServer, misaoRef, { command: undefined, extraEnv: { AZITO_UI_TOKEN: 'test-token' } });
  });

  it('labels the pane of a registered non-task window with its windowId', async () => {
    const windowRepo = makeWindowRepo();
    (windowRepo.findByServerAndRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 7, ownerType: 'project', taskId: null, projectId: 1, serverName: 'misao1', tmuxTarget: 'ws-a:main', isPrimary: false,
    });
    await build(vi.fn(), { windowRepo });
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(openPaneInWindow).toHaveBeenCalledWith(misaoServer, misaoRef, { command: undefined, extraEnv: { AZITO_UI_TOKEN: 'test-token' }, labels: { windowId: 7 } });
  });

  it('opens an unregistered window without labels', async () => {
    await build(vi.fn(), { windowRepo: makeWindowRepo() });
    await app.inject({ method: 'POST', url });
    expect(openPaneInWindow.mock.calls[0]).toEqual([misaoServer, misaoRef, expect.not.objectContaining({ labels: expect.anything() })]);
  });

  it("rejects with 409 for a task's primary window", async () => {
    await build(vi.fn(), { windowRepo: taskWindowRepo(true) });
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('primary_task_window_pane_add_unsupported');
    expect(openPaneInWindow).not.toHaveBeenCalled();
  });

  it('gives a secondary task window the masked env, never the operator UI token', async () => {
    const maskedEnv = { AZITO_TASK_ID: '42', AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' };
    const buildSecondaryWindowEnv = vi.fn(() => maskedEnv);
    await build(vi.fn(), { windowRepo: taskWindowRepo(false), buildSecondaryWindowEnv });
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(200);
    expect(buildSecondaryWindowEnv).toHaveBeenCalledWith(42, misaoServer);
    expect(openPaneInWindow).toHaveBeenCalledWith(misaoServer, misaoRef, { command: undefined, extraEnv: maskedEnv, labels: { windowId: 5, taskId: 42 } });
  });

  it('answers 501 on a tmux server (tmux windows never lose their last pane)', async () => {
    const tmuxServer = { name: 'tmux1', type: 'local', muxRuntime: 'system' } as ServerConfig;
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('tmux', { openPaneInWindow: TmuxClientImpl.prototype.openPaneInWindow } as unknown as IMuxClient);
    app = Fastify();
    app.setErrorHandler((err, _request, reply) => {
      if (err instanceof MuxOperationUnsupportedError) return reply.status(501).send({ error: 'mux_operation_unsupported', operation: err.operation });
      return reply.status(500).send({ error: 'unexpected' });
    });
    await app.register(sessionsRoutes, {
      serverRepo: makeServerRepo(tmuxServer),
      tmux: {} as unknown as TmuxClient,
      uiToken: 'test-token',
      muxDriverRegistry: registry,
      serverIsolationMutex: new KeyedMutex(),
    });
    await app.ready();
    const tmuxRef = encodeURIComponent(JSON.stringify({ kind: 'tmux', workspace: 'main', window: 'w1' }));
    const res = await app.inject({ method: 'POST', url: `/api/servers/tmux1/mux/windows/${tmuxRef}/panes/open` });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ error: 'mux_operation_unsupported', operation: 'openPaneInWindow' });
  });
});

describe('mux creation routes hand the new pane its env inside the per-server lock', () => {
  const windowId = 'w_0123456789ABCDEFGHJKMNPQRS';
  const ref = { kind: 'misao', workspace: 'ws-a', window: windowId } as const;
  const refParam = encodeURIComponent(JSON.stringify(ref));
  const MASKED = { AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' };
  let app: FastifyInstance;
  let lockHeld = false;
  const heldAtCall: boolean[] = [];

  const openWorkspace = vi.fn(async () => { heldAtCall.push(lockHeld); return { ref, result: { stdout: '', stderr: '', code: 0 } }; });
  const openWindow = vi.fn(async () => { heldAtCall.push(lockHeld); return { ref, result: { stdout: '', stderr: '', code: 0 }, windowName: 'main' }; });
  const splitPaneByHandle = vi.fn(async () => { heldAtCall.push(lockHeld); return { handle: 'p_2', result: { stdout: '', stderr: '', code: 0 } }; });
  const driver = {
    openWorkspace, openWindow, splitPaneByHandle,
    resolvePane: vi.fn(async () => 'p_1'),
  } as unknown as IMuxClient;

  async function build(server: ServerConfig, extra: { windowRepo?: SqliteWindowRepository; buildSecondaryWindowEnv?: (taskId: number, server: ServerConfig) => Record<string, string> } = {}) {
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', driver);
    const mutex = new KeyedMutex();
    const withLock = mutex.withLock.bind(mutex);
    mutex.withLock = (async (key: string, fn: () => Promise<unknown>) => withLock(key, async () => { lockHeld = true; try { return await fn(); } finally { lockHeld = false; } })) as typeof mutex.withLock;
    app = Fastify();
    await app.register(sessionsRoutes, {
      serverRepo: makeServerRepo(server),
      tmux: {} as unknown as TmuxClient,
      uiToken: 'test-token',
      muxDriverRegistry: registry,
      notificationBus: { emit: vi.fn() } as never,
      serverIsolationMutex: mutex,
      ...extra,
    });
    await app.ready();
  }

  const normal = { name: 'misao1', type: 'local', muxRuntime: 'misao', isolationIntent: false } as ServerConfig;
  const isolated = { ...normal, isolationIntent: true } as ServerConfig;

  afterEach(async () => {
    openWorkspace.mockClear(); openWindow.mockClear(); splitPaneByHandle.mockClear(); heldAtCall.length = 0;
    await app.close();
  });

  it('POST /mux/workspaces passes the UI token env, inside the lock', async () => {
    await build(normal);
    const res = await app.inject({ method: 'POST', url: '/api/servers/misao1/mux/workspaces', payload: { name: 'ws-a' } });
    expect(res.statusCode).toBe(200);
    expect(openWorkspace).toHaveBeenCalledWith(normal, 'ws-a', { windowName: undefined, extraEnv: { AZITO_UI_TOKEN: 'test-token' } });
    expect(heldAtCall).toEqual([true]);
  });

  it('POST /mux/workspaces passes the mask env, never the UI token, to an isolated server', async () => {
    await build(isolated);
    await app.inject({ method: 'POST', url: '/api/servers/misao1/mux/workspaces', payload: { name: 'ws-a' } });
    expect(openWorkspace).toHaveBeenCalledWith(isolated, 'ws-a', { windowName: undefined, extraEnv: MASKED });
  });

  it('POST /mux/workspaces/:ws/windows passes the UI token env, inside the lock', async () => {
    await build(normal);
    const res = await app.inject({ method: 'POST', url: '/api/servers/misao1/mux/workspaces/ws-a/windows', payload: { name: 'main' } });
    expect(res.statusCode).toBe(200);
    expect(openWindow).toHaveBeenCalledWith(normal, 'ws-a', 'main', { extraEnv: { AZITO_UI_TOKEN: 'test-token' } });
    expect(heldAtCall).toEqual([true]);
  });

  it('POST /mux/workspaces/:ws/windows passes the mask env to an isolated server', async () => {
    await build(isolated);
    await app.inject({ method: 'POST', url: '/api/servers/misao1/mux/workspaces/ws-a/windows', payload: {} });
    expect(openWindow).toHaveBeenCalledWith(isolated, 'ws-a', undefined, { extraEnv: MASKED });
  });

  it('POST /mux/windows/:ref/panes (split) passes the UI token env, inside the lock', async () => {
    await build(normal, { windowRepo: makeWindowRepo() });
    const res = await app.inject({ method: 'POST', url: `/api/servers/misao1/mux/windows/${refParam}/panes`, payload: { direction: 'h' } });
    expect(res.statusCode).toBe(200);
    expect(splitPaneByHandle).toHaveBeenCalledWith(normal, 'p_1', 'h', { AZITO_UI_TOKEN: 'test-token' });
    expect(heldAtCall).toEqual([true]);
  });

  it('POST /mux/windows/:ref/panes (split) passes the mask env to an isolated server', async () => {
    await build(isolated, { windowRepo: makeWindowRepo() });
    await app.inject({ method: 'POST', url: `/api/servers/misao1/mux/windows/${refParam}/panes`, payload: {} });
    expect(splitPaneByHandle).toHaveBeenCalledWith(isolated, 'p_1', 'v', MASKED);
  });

  it('POST /mux/windows/:ref/panes (split) gives a secondary task window its own masked env', async () => {
    const windowRepo = makeWindowRepo();
    (windowRepo.findByServerAndRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'misao1', tmuxTarget: 'ws-a:main', isPrimary: false,
    });
    const taskEnv = { AZITO_TASK_ID: '42', ...MASKED };
    const buildSecondaryWindowEnv = vi.fn(() => taskEnv);
    await build(normal, { windowRepo, buildSecondaryWindowEnv });
    const res = await app.inject({ method: 'POST', url: `/api/servers/misao1/mux/windows/${refParam}/panes`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(buildSecondaryWindowEnv).toHaveBeenCalledWith(42, normal);
    expect(splitPaneByHandle).toHaveBeenCalledWith(normal, 'p_1', 'v', taskEnv);
  });

  it('POST /mux/windows/:ref/panes (split) still refuses a task primary window', async () => {
    const windowRepo = makeWindowRepo();
    (windowRepo.findByServerAndRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'misao1', tmuxTarget: 'ws-a:main', isPrimary: true,
    });
    await build(normal, { windowRepo });
    const res = await app.inject({ method: 'POST', url: `/api/servers/misao1/mux/windows/${refParam}/panes`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(splitPaneByHandle).not.toHaveBeenCalled();
  });
});

describe('unreachable agent server', () => {
  it('rethrows AgentUnreachableError from GET /sessions so the app error handler can answer 503', async () => {
    const srv: ServerConfig = { name: 'srv1', type: 'agent' } as ServerConfig;
    const tmux: Partial<TmuxClient> = {
      listSessions: vi.fn(async () => { throw new AgentUnreachableError('srv1', 'refused'); }),
    };
    const app = Fastify();
    app.setErrorHandler((err, _req, reply) => {
      const mapped = mapAppError(err);
      if (mapped) return reply.status(mapped.status).send(mapped.body);
      return reply.status(500).send({ error: (err as Error).message });
    });
    await app.register(sessionsRoutes, {
      serverRepo: makeServerRepo(srv),
      tmux: tmux as TmuxClient,
      uiToken: 'test-token',
      windowRepo: makeWindowRepo(),
      serverIsolationMutex: new KeyedMutex(),
    });
    await app.ready();
    try {
      invalidateSessionCache('srv1');
      const res = await app.inject({ method: 'GET', url: '/api/servers/srv1/sessions' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'agent_unreachable', server: 'srv1', reason: 'refused' });
    } finally {
      await app.close();
    }
  });
});
