import type { FastifyPluginCallback } from 'fastify';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { TmuxClient, TmuxSession } from '../TmuxClient';
import type { SqliteWindowRepository } from '../../windows/SqliteWindowRepository';
import { isPrimaryTaskWindow } from '../../windows/SqliteWindowRepository';
import type { NotificationBus } from '../../notifications/NotificationBus';
import type { ResourceGuard } from '../../servers/resources/ResourceGuard';
import { resolveKillOutcome } from '../killOutcome';

// ─── Types ───

export interface SessionsRouteOptions {
  serverRepo: IServerRepository;
  tmux: TmuxClient;
  windowRepo?: SqliteWindowRepository;
  notificationBus?: NotificationBus;
  resourceGuard?: ResourceGuard;
  /**
   * Issue #28 third-party review finding: kill-window here must revoke a
   * task-owned window's token generation the same way the task-execution
   * rollback paths do (see
   * TaskPaneEnvironmentService.revokeForDestroyedWindow's doc comment) —
   * this is the generic tmux-kill route (terminal UI "close window",
   * ProjectSettings, etc.), so it has no other reason to know a window
   * belongs to a task without this. A plain callback, not a
   * `TaskPaneEnvironmentService` import, because `tmux` is a base-layer
   * module (.dependency-cruiser.cjs's `base-tmux-limited-upward` rule) and
   * must not depend on `tasks` (an upper-layer module) — buildServer.ts (the
   * composition root) closes over the real service and passes just this
   * function.
   *
   * Call sites below gate this with `isPrimaryTaskWindow(win)` (Issue #28
   * third-party review finding — multi-window token rotation collision): a
   * task's token generation is bound one-to-one to its PRIMARY worker
   * window, so destroying a secondary window (added via
   * `POST /api/tasks/:id/windows`) must never revoke it — that would 401 the
   * still-live primary pane. See isPrimaryTaskWindow's doc comment
   * (windows/Window.ts) for the shared judgment.
   */
  onTaskWindowDestroyed?: (taskId: number, reason: string) => void;

  /**
   * Issue #28 third-party review finding (manual "add pane" route leaking
   * session env into a secondary task-owned window): mirrors
   * `onTaskWindowDestroyed`'s reasoning for why this is a plain callback and
   * not a `TaskPaneEnvironmentService` import — `tmux` is a base-layer
   * module and must not depend on `tasks` (upper layer). Returns the SAME
   * masked-only env `TaskPaneEnvironmentService.buildEnvForSecondaryWindow`
   * produces for a secondary task window's own (re)creation; never issues
   * or touches a task token. Only called for a window whose `taskId` is
   * non-null and `isPrimaryTaskWindow(win)` is false — buildServer.ts wires
   * this to look up the task and call `buildEnvForSecondaryWindow` on it.
   */
  buildSecondaryWindowEnv?: (taskId: number, server: ServerConfig) => Record<string, string>;
}

// ─── Session cache (30 s TTL) ───

const sessionCache = new Map<string, { data: TmuxSession[]; ts: number }>();
const SESSION_CACHE_TTL = 30000;

export function invalidateSessionCache(serverName: string): void {
  sessionCache.delete(serverName);
}

// ─── Linked-session GC throttle (60 s per server) ───

const lastGcRun = new Map<string, number>();
const GC_INTERVAL = 60000;

// ─── Plugin ───

const sessionsRoutes: FastifyPluginCallback<SessionsRouteOptions> = (fastify, opts, done) => {
  const { serverRepo, tmux } = opts;

  // Invalidate the hub-side cache AND push a sessions:updated notification, so clients
  // refresh immediately after a hub-initiated mutation. Remote (ssh/agent) servers have
  // no reliable tmux-hook path back to the hub, so relying on hooks alone leaves the UI
  // stale for up to SESSION_CACHE_TTL.
  function notifySessionsChanged(serverName: string): void {
    sessionCache.delete(serverName);
    opts.notificationBus?.emit({ type: 'sessions:updated', payload: { serverName } });
  }

  // ── GET /api/servers/:name/sessions ──
  fastify.get<{ Params: { name: string } }>(
    '/api/servers/:name/sessions',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const cached = sessionCache.get(request.params.name);
      if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL) {
        return cached.data;
      }

      try {
        const sessions = await tmux.listSessions(srv);
        sessionCache.set(request.params.name, { data: sessions, ts: Date.now() });

        const now = Date.now();
        const lastRun = lastGcRun.get(request.params.name) ?? 0;
        if (now - lastRun > GC_INTERVAL) {
          lastGcRun.set(request.params.name, now);
          tmux.cleanupLinkedSessions(srv).then((n) => {
            if (n > 0) fastify.log.info(`GC: cleaned ${n} linked session(s) on ${request.params.name}`);
          }).catch(() => {});
        }

        return sessions;
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/servers/:name/sessions ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/sessions',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { name, command, windowName: reqWindowName, force } = request.body as { name?: string; command?: string; windowName?: string; force?: boolean };
      if (!name) return reply.status(400).send({ error: 'Session name required' });
      if (opts.resourceGuard && force !== true) {
        const status = await opts.resourceGuard.check(srv);
        if (!status.ok)
          return reply.status(409).send({ error: 'insufficient_resources', resources: status });
      }
      try {
        const { result, windowName } = await tmux.createSession(srv, name, { command, windowName: reqWindowName, extraEnv: tmux.uiTokenEnv() });
        // Agent/SSH transports resolve with a non-zero code instead of throwing — surface it.
        if (result.code !== 0)
          return reply.status(500).send({ error: `new-session failed: ${result.stderr || result.stdout}` });
        notifySessionsChanged(request.params.name);
        return { ok: true, windowName };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/servers/:name/sessions/:session/windows ──
  fastify.post<{ Params: { name: string; session: string } }>(
    '/api/servers/:name/sessions/:session/windows',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { name: reqName, force } = (request.body as { name?: string; force?: boolean } | null) || {};
      if (opts.resourceGuard && force !== true) {
        const status = await opts.resourceGuard.check(srv);
        if (!status.ok)
          return reply.status(409).send({ error: 'insufficient_resources', resources: status });
      }
      try {
        const { result, windowName } = await tmux.createWindow(srv, request.params.session, reqName || undefined, { extraEnv: tmux.uiTokenEnv() });
        if (result.code !== 0)
          return reply.status(500).send({ error: `new-window failed: ${result.stderr || result.stdout}` });
        notifySessionsChanged(request.params.name);
        return { ok: true, windowName };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/servers/:name/sessions/:session/windows/:window/panes ──
  fastify.post<{ Params: { name: string; session: string; window: string } }>(
    '/api/servers/:name/sessions/:session/windows/:window/panes',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const direction = ((request.body as Record<string, unknown>)?.direction as string) || 'v';
      const target = `${request.params.session}:${request.params.window}`;
      try {
        // Resolve whether the target window belongs to a task BEFORE
        // splitting (Issue #28 third-party review finding: this generic
        // "add pane" route previously always split with no extraEnv at all,
        // so the new pane silently inherited whatever the tmux SESSION's own
        // environment happened to carry — a lingering AZITO_UI_TOKEN on an
        // older session grants the new pane operator-level credentials it
        // was never issued, and a task-owned window's new pane never got
        // AZITO_TASK_TOKEN). Mirrors the identity-fallback lookup the
        // kill-window route above uses, since this route's `target` is
        // likewise constructed from URL params rather than resolved via
        // tmux first.
        const identity = await tmux.getWindowIdentity(srv, target);
        const windowRow = opts.windowRepo?.findByServerAndTarget(request.params.name, target)
          ?? (identity ? opts.windowRepo?.findByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowName}`) : undefined)
          ?? (identity ? opts.windowRepo?.findByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowIndex}`) : undefined);

        let extraEnv: Record<string, string>;
        if (windowRow && windowRow.taskId !== null && isPrimaryTaskWindow(windowRow)) {
          // The task's PRIMARY worker window. Its already-running first pane
          // holds the currently-active AZITO_TASK_TOKEN generation in its
          // process env, and that plaintext is never persisted anywhere
          // (design v3 §2 — TaskPaneEnvironmentService issues but never
          // stores a token's plaintext). There is therefore no value this
          // route could hand the new pane that is simultaneously (a) the
          // SAME generation the first pane already holds — required, since
          // every pane in one tmux window must carry an identical env per
          // TmuxClient.splitPane's doc comment — and (b) obtained without
          // rotating, which would revoke that still-in-use generation out
          // from under the running worker pane. Reject rather than either
          // silently omitting the token (this finding's original bug) or
          // minting a fresh, unrelated generation only the new pane would
          // hold. Respawning the window (which rotates once and applies the
          // new generation to every pane it recreates) is the supported way
          // to add a pane here.
          return reply.status(409).send({
            error: 'primary_task_window_pane_add_unsupported',
            message: "Cannot add a pane to a task's primary window directly — respawn the window first, then add panes.",
          });
        } else if (windowRow && windowRow.taskId !== null) {
          // Secondary task-owned window: masked-only env (no task token),
          // same as its own (re)creation env.
          extraEnv = opts.buildSecondaryWindowEnv?.(windowRow.taskId, srv) ?? {};
        } else {
          // Non-task window (manual/project/etc.) — legacy default.
          extraEnv = tmux.uiTokenEnv();
        }

        await tmux.splitPane(srv, target, direction as 'h' | 'v', extraEnv);
        notifySessionsChanged(request.params.name);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/servers/:name/sessions/:session ──
  fastify.delete<{ Params: { name: string; session: string } }>(
    '/api/servers/:name/sessions/:session',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      try {
        // Resolve every window this session holds BEFORE killing it — once
        // the session is gone, tmux can no longer tell us which windows it
        // held, and this is the only chance to learn which of them were
        // task-owned (Issue #28 third-party review finding 4: deleting a
        // whole session previously revoked no task tokens at all — only the
        // single-window DELETE route below did, via onTaskWindowDestroyed).
        const sessionWindows = opts.windowRepo?.findByServerAndSession(request.params.name, request.params.session) ?? [];

        // resolveKillOutcome normalizes local (throws on failure) vs agent
        // (resolves with a non-zero code) transports into one verdict — see
        // its doc comment.
        const outcome = await resolveKillOutcome(tmux.killSession(srv, request.params.session));
        if (!outcome.success) {
          return reply.status(500).send({ error: `kill-session failed: ${outcome.result.stderr || outcome.result.stdout}` });
        }
        // Success (killed, or tmux already reported it missing) — fall
        // through to DB cleanup + revocation below.
        notifySessionsChanged(request.params.name);

        // Reaching here means the session is confirmed gone (killed, or
        // tmux already reported it missing) — safe to clean up every window
        // row it held and revoke each task-owned window's token, reusing
        // the exact same callback the single-window route uses below
        // (never a second revocation implementation).
        for (const win of sessionWindows) {
          opts.windowRepo?.removeByServerAndTarget(request.params.name, win.tmuxTarget);
          if (win.taskId !== null && isPrimaryTaskWindow(win)) {
            opts.onTaskWindowDestroyed?.(win.taskId, 'window_killed_via_session_delete');
          }
        }
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/servers/:name/windows/:target ──
  fastify.delete<{ Params: { name: string; target: string } }>(
    '/api/servers/:name/windows/:target',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      try {
        const target = decodeURIComponent(request.params.target);
        // Resolve identity before killing — once the window is gone, tmux can no longer tell us
        // its canonical name/index, and the sidebar's index-form target ("session:2") won't match
        // the name-form target ("session:win--xxxx") the DB row was stored under.
        const identity = await tmux.getWindowIdentity(srv, target);
        // Resolved before the DB cleanup below removes the row(s) — this is
        // the only chance to learn whether the window being destroyed
        // belonged to a task (Issue #28 third-party review finding: this
        // generic kill route must revoke that task's token generation the
        // same as the task-execution rollback paths, since a destroyed
        // window can never again be resumed onto).
        const windowRow = opts.windowRepo?.findByServerAndTarget(request.params.name, target)
          ?? (identity ? opts.windowRepo?.findByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowName}`) : undefined)
          ?? (identity ? opts.windowRepo?.findByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowIndex}`) : undefined);
        // resolveKillOutcome normalizes local (throws on failure) vs agent
        // (resolves with a non-zero code) transports into one verdict — see
        // its doc comment.
        const outcome = await resolveKillOutcome(tmux.killWindow(srv, target));
        if (!outcome.success) {
          return reply.status(500).send({ error: `kill-window failed: ${outcome.result.stderr || outcome.result.stdout}` });
        }
        // Success (killed, or tmux already reported it missing) — fall
        // through to DB cleanup below.
        notifySessionsChanged(request.params.name);
        opts.windowRepo?.removeByServerAndTarget(request.params.name, target);
        if (identity) {
          opts.windowRepo?.removeByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowName}`);
          opts.windowRepo?.removeByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowIndex}`);
        }
        // Reaching here means the window is confirmed gone (kill-window
        // succeeded, or tmux already reported it missing) — safe to revoke.
        if (windowRow && windowRow.taskId !== null && isPrimaryTaskWindow(windowRow)) {
          opts.onTaskWindowDestroyed?.(windowRow.taskId, 'window_killed_via_sessions_route');
        }
        // Clients hold terminal tabs under both name-form and index-form targets;
        // return the resolved identity so they can close every matching tab.
        return { ok: true, identity };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/servers/:name/panes/:target ──
  fastify.delete<{ Params: { name: string; target: string } }>(
    '/api/servers/:name/panes/:target',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      try {
        const target = decodeURIComponent(request.params.target);
        const result = await tmux.killPane(srv, target)
          .catch((err: Error) => ({ stdout: '', stderr: err.message, code: 1 }));
        if (result.code !== 0) {
          const output = `${result.stderr || ''}${result.stdout || ''}`;
          const alreadyGone = output.includes("can't find");
          if (!alreadyGone)
            return reply.status(500).send({ error: `kill-pane failed: ${result.stderr || result.stdout}` });
          // Already gone — fall through to DB cleanup below. Note: the window itself may still be
          // alive (only this pane was removed), so we do not resolve/clean up window identities here.
        }
        notifySessionsChanged(request.params.name);
        opts.windowRepo?.removeByServerAndTarget(request.params.name, target);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── PUT /api/servers/:name/sessions/:session/rename ──
  fastify.put<{ Params: { name: string; session: string } }>(
    '/api/servers/:name/sessions/:session/rename',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { name } = request.body as { name?: string };
      if (!name) return reply.status(400).send({ error: 'New name required' });
      try {
        await tmux.renameSession(srv, request.params.session, name);
        notifySessionsChanged(request.params.name);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── PUT /api/servers/:name/windows/:target/rename ──
  fastify.put<{ Params: { name: string; target: string } }>(
    '/api/servers/:name/windows/:target/rename',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { name } = request.body as { name?: string };
      if (!name) return reply.status(400).send({ error: 'New name required' });
      try {
        await tmux.renameWindow(srv, decodeURIComponent(request.params.target), name);
        notifySessionsChanged(request.params.name);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── PUT /api/servers/:name/panes/:target/rename ──
  fastify.put<{ Params: { name: string; target: string } }>(
    '/api/servers/:name/panes/:target/rename',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { title } = request.body as { title?: string };
      if (!title) return reply.status(400).send({ error: 'New title required' });
      try {
        await tmux.renamePane(srv, decodeURIComponent(request.params.target), title);
        notifySessionsChanged(request.params.name);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/servers/:name/panes/:target/capture ──
  fastify.get<{
    Params: { name: string; target: string };
    Querystring: { start?: string; end?: string; history?: string };
  }>(
    '/api/servers/:name/panes/:target/capture',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const startLine = request.query.start != null ? parseInt(request.query.start, 10) : undefined;
      const endLine = request.query.end != null ? parseInt(request.query.end, 10) : undefined;
      const decodedTarget = decodeURIComponent(request.params.target);

      // Legacy: ?history=N
      if (startLine == null && endLine == null && request.query.history) {
        const h = parseInt(request.query.history, 10);
        try {
          const { stdout } = await tmux.capturePane(srv, decodedTarget, -h, undefined);
          return { content: stdout };
        } catch (err: unknown) {
          return reply.status(500).send({ error: (err as Error).message });
        }
      }

      try {
        const { stdout } = await tmux.capturePane(srv, decodedTarget, startLine, endLine);
        return { content: stdout };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/servers/:name/panes/:target/send-keys ──
  fastify.post<{ Params: { name: string; target: string } }>(
    '/api/servers/:name/panes/:target/send-keys',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { keys } = request.body as { keys?: string[] };
      if (!keys || !Array.isArray(keys))
        return reply.status(400).send({ error: 'keys array required' });
      try {
        await tmux.sendKeys(srv, decodeURIComponent(request.params.target), keys);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/servers/:name/panes/:target/zoom ──
  fastify.post<{ Params: { name: string; target: string } }>(
    '/api/servers/:name/panes/:target/zoom',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      try {
        await tmux.zoomPane(srv, decodeURIComponent(request.params.target));
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/servers/:name/panes/:target/unzoom ──
  fastify.post<{ Params: { name: string; target: string } }>(
    '/api/servers/:name/panes/:target/unzoom',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      try {
        await tmux.unzoomPane(srv, decodeURIComponent(request.params.target));
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  done();
};

export default sessionsRoutes;
