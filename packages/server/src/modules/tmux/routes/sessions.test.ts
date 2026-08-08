import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sessionsRoutes from './sessions';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { TmuxClient } from '../TmuxClient';
import type { SqliteWindowRepository } from '../../windows/SqliteWindowRepository';

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

async function buildApp(opts: {
  tmux: Partial<TmuxClient>;
  windowRepo: SqliteWindowRepository;
  onTaskWindowDestroyed?: ReturnType<typeof vi.fn>;
}): Promise<FastifyInstance> {
  const srv: ServerConfig = { name: 'srv1', type: 'local' } as ServerConfig;
  const app = Fastify();
  await app.register(sessionsRoutes, {
    serverRepo: makeServerRepo(srv),
    tmux: opts.tmux as TmuxClient,
    windowRepo: opts.windowRepo,
    onTaskWindowDestroyed: opts.onTaskWindowDestroyed as ((taskId: number, reason: string) => void) | undefined,
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
        id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2',
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      };
      const onTaskWindowDestroyed = vi.fn();
      app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(200);
      expect(onTaskWindowDestroyed).toHaveBeenCalledWith(42, 'window_killed_via_sessions_route');
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
      const onTaskWindowDestroyed = vi.fn();
      app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(200);
      expect(onTaskWindowDestroyed).not.toHaveBeenCalled();
    });

    it('does NOT revoke when kill-window fails for a reason other than "already gone" (window may still be alive)', async () => {
      const windowRepo = makeWindowRepo();
      (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2',
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 })),
      };
      const onTaskWindowDestroyed = vi.fn();
      app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(500);
      expect(onTaskWindowDestroyed).not.toHaveBeenCalled();
    });

    it('still revokes when kill-window reports the window already gone ("can\'t find")', async () => {
      const windowRepo = makeWindowRepo();
      (windowRepo.findByServerAndTarget as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 5, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:2',
      });
      const tmux: Partial<TmuxClient> = {
        getWindowIdentity: vi.fn(async () => null),
        killWindow: vi.fn(async () => ({ stdout: '', stderr: "can't find window: 2", code: 1 })),
      };
      const onTaskWindowDestroyed = vi.fn();
      app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

      const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/windows/session:2' });

      expect(res.statusCode).toBe(200);
      expect(onTaskWindowDestroyed).toHaveBeenCalledWith(42, 'window_killed_via_sessions_route');
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

  it('revokes every task-owned window in the session and cleans up all window rows', async () => {
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42' },
      { id: 2, ownerType: 'task', taskId: 43, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-43' },
      { id: 3, ownerType: 'project', taskId: null, projectId: 1, serverName: 'srv1', tmuxTarget: 'session:extra' },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    const onTaskWindowDestroyed = vi.fn();
    app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    expect(onTaskWindowDestroyed).toHaveBeenCalledWith(42, 'window_killed_via_session_delete');
    expect(onTaskWindowDestroyed).toHaveBeenCalledWith(43, 'window_killed_via_session_delete');
    expect(onTaskWindowDestroyed).toHaveBeenCalledTimes(2);
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-42');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-43');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:extra');
  });

  it('does not revoke or clean up when kill-session fails for a reason other than "already gone"', async () => {
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42' },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 })),
    };
    const onTaskWindowDestroyed = vi.fn();
    app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(500);
    expect(onTaskWindowDestroyed).not.toHaveBeenCalled();
    expect(windowRepo.removeByServerAndTarget).not.toHaveBeenCalled();
  });

  it('still revokes and cleans up when kill-session reports the session already gone', async () => {
    const windowRepo = makeWindowRepo();
    windowRepo.findByServerAndSession.mockReturnValue([
      { id: 1, ownerType: 'task', taskId: 42, projectId: null, serverName: 'srv1', tmuxTarget: 'session:task-42' },
    ]);
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: "can't find session: session", code: 1 })),
    };
    const onTaskWindowDestroyed = vi.fn();
    app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    expect(onTaskWindowDestroyed).toHaveBeenCalledWith(42, 'window_killed_via_session_delete');
    expect(windowRepo.removeByServerAndTarget).toHaveBeenCalledWith('srv1', 'session:task-42');
  });

  it('does not revoke anything when the session has no windows at all', async () => {
    const windowRepo = makeWindowRepo();
    const tmux: Partial<TmuxClient> = {
      killSession: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    };
    const onTaskWindowDestroyed = vi.fn();
    app = await buildApp({ tmux, windowRepo, onTaskWindowDestroyed });

    const res = await app.inject({ method: 'DELETE', url: '/api/servers/srv1/sessions/session' });

    expect(res.statusCode).toBe(200);
    expect(onTaskWindowDestroyed).not.toHaveBeenCalled();
    expect(windowRepo.removeByServerAndTarget).not.toHaveBeenCalled();
  });
});
