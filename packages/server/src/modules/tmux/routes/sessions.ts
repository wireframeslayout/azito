import type { FastifyPluginCallback } from 'fastify';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { ExecResult } from '../../servers/transport/ServerTransport';
import type { TmuxClient, TmuxSession } from '../TmuxClient';
import type { SqliteWindowRepository } from '../../windows/SqliteWindowRepository';
import { isPrimaryTaskWindow } from '../../windows/SqliteWindowRepository';
import type { NotificationBus } from '../../notifications/NotificationBus';
import type { ResourceGuard } from '../../servers/resources/ResourceGuard';
import { resolveKillOutcome, type KillOutcome } from '../killOutcome';

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
   * `TaskPaneEnvironmentService`/`TaskWindowDestruction` import, because
   * `tmux` is a base-layer module (.dependency-cruiser.cjs's
   * `base-tmux-limited-upward` rule) and must not depend on `tasks` (an
   * upper-layer module) — buildServer.ts (the composition root) closes over
   * `destroyPrimaryTaskWindow` (modules/tasks/execution/
   * TaskWindowDestruction.ts) and passes just this function.
   *
   * Second-round finding: the kill itself must run INSIDE the same per-task
   * lock the revoke does (`runExclusiveForTask`, via
   * `destroyPrimaryTaskWindow`) — a plain "kill here, then fire a
   * synchronous revoke callback" left a gap between kill success and revoke
   * where a concurrent respawn could issue and persist a newer generation,
   * which the revoke (a blanket revoke-all-for-task) would then wrongly take
   * out. `kill` and `onDestroyed` are supplied per call site (the actual
   * tmux kill call and `windows` table row cleanup differ per route); the
   * callback resolves once the whole locked sequence has settled, so the
   * caller waits for it before building its HTTP reply.
   *
   * Call sites below gate this with `isPrimaryTaskWindow(win)` (Issue #28
   * third-party review finding — multi-window token rotation collision): a
   * task's token generation is bound one-to-one to its PRIMARY worker
   * window, so destroying a secondary window (added via
   * `POST /api/tasks/:id/windows`) must never revoke it — that would 401 the
   * still-live primary pane. See isPrimaryTaskWindow's doc comment
   * (windows/Window.ts) for the shared judgment.
   */
  destroyPrimaryTaskWindow?: (
    taskId: number,
    windowName: string,
    /**
     * Issue #28 third-party review, second round: `serverName`/`target`
     * (the same tmux target the killed window registered its supervisor
     * connection under, if any) are passed through so buildServer.ts's
     * wiring — the only place with a `SupervisorRegistry` in scope — can
     * also expire that launch (`SupervisorRegistry.resolveLaunchForExpiry`/
     * `expireResolvedLaunch`) as part of the same destroy, alongside the
     * task-token revoke. Neither
     * `TaskWindowDestruction.destroyPrimaryTaskWindow` (the underlying
     * function) nor this route needs to know about supervisors at all —
     * this is pure pass-through.
     */
    serverName: string,
    target: string,
    reason: string,
    kill: () => Promise<ExecResult>,
    onDestroyed: () => void,
  ) => Promise<KillOutcome>;

  /**
   * Session-wide sibling of {@link destroyPrimaryTaskWindow} (Issue #28
   * third-party review, D-track fix 1) — used by `DELETE
   * /api/servers/:name/sessions/:session` instead of calling `kill` +
   * looping `destroyPrimaryTaskWindow` per window. A whole-session kill can
   * tear down several tasks' primary windows in ONE tmux call, so the kill
   * itself must be serialized against ALL of those tasks' rotation locks at
   * once (`runExclusiveForTasks`, via
   * `TaskWindowDestruction.destroyPrimaryTaskWindowsForSessionKill`) — never
   * against just one, and never outside any lock at all. See that
   * function's doc comment for the race this closes (a concurrent respawn
   * landing a new window generation between this route's pre-kill window
   * listing and the actual `killSession` call, which the session kill then
   * destroys right along with everything else — a per-window-after-the-fact
   * lock can no longer tell that new generation was destroyed too, and
   * leaves its token valid forever).
   *
   * `resolveWindows` re-lists every PRIMARY task-owned window the session
   * CURRENTLY holds (secondary task windows and non-task windows are cleaned
   * up by the route directly — see the route body) — a callback, not a
   * pre-resolved array, because `destroyPrimaryTaskWindowsForSessionKill`
   * calls it again INSIDE the lock, right before the kill, to guard against
   * the pre-lock listing going stale while this call was queued behind an
   * in-flight rotation for one of the same tasks (see that function's doc
   * comment). Returns the `target`s of every window it actually
   * killed/revoked, via `handledTargets`, so the route's own cleanup of
   * secondary/non-task rows can skip them.
   */
  destroySessionWindows?: (
    resolveWindows: () => Array<{ taskId: number; windowName: string; target: string; onDestroyed: () => void }>,
    serverName: string,
    reason: string,
    killSession: () => Promise<ExecResult>,
  ) => Promise<{ outcome: KillOutcome; handledTargets: Set<string> }>;

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

// ─── Helpers ───

/**
 * Extracts the plain window name from a `windows` table row's `tmuxTarget`
 * (always stored `<sessionName>:<windowName>` — see Window.ts/callers that
 * `add()` a row). This is the same shape `task.tmuxWindow` is compared
 * against (`ExecuteTaskUseCase`/`WindowRespawnService` persist
 * `created.windowName`, a plain name, never a `session:window` pair), so
 * this is what `destroyPrimaryTaskWindow`'s reread (`clearTmuxWindowIfMatches`)
 * needs. Returns `undefined` if `tmuxTarget` has no `:` separator (should be
 * unreachable given how rows are always written, but this is a boundary
 * between a DB row and the reread call, so fail closed rather than pass a
 * garbage window name into a revoke decision).
 */
function windowNameFromTarget(tmuxTarget: string): string | undefined {
  const idx = tmuxTarget.indexOf(':');
  if (idx < 0) return undefined;
  return tmuxTarget.slice(idx + 1);
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
        // Re-resolvable listing of every PRIMARY task-owned window the
        // session CURRENTLY holds. Passed as a callback (not a one-shot
        // snapshot) — destroySessionWindows re-invokes it INSIDE its lock,
        // right before the kill, since a snapshot taken here (before any
        // lock is held) can go stale behind an in-flight rotation for one of
        // the same tasks (Issue #28 third-party review, follow-up fix — see
        // TaskWindowDestruction.destroyPrimaryTaskWindowsForSessionKill's doc
        // comment for the race this closes).
        // Full row-ID snapshot of the session, captured as a side effect of
        // every `resolvePrimaryTaskWindows()` call (see below). Issue #28
        // third-party review, batch-2 finding: the OLD "remaining rows"
        // cleanup re-fetched `findByServerAndSession` AFTER the kill and
        // deleted by `target` — but tmux window targets ("session:2") are
        // reused for brand-new windows, so a row created for a NEW window in
        // the gap between kill and that re-fetch (same session, same reused
        // index) could be deleted here even though it has nothing to do with
        // the window this call killed. Deleting by row `id` instead (a value
        // that can never be reused) makes that impossible: only rows that
        // actually existed at the captured snapshot moment are ever removed.
        // `resolvePrimaryTaskWindows` is re-invoked by `destroySessionWindows`
        // INSIDE its per-task lock, immediately before the kill (see its own
        // doc comment) — the LAST call before the kill actually runs is the
        // authoritative one, so this snapshot always reflects that same
        // instant. Recording it as a side effect of an already-idempotent,
        // already-DB-only read (no tmux/network calls) does not change its
        // observable behavior for any existing caller.
        let sessionRowSnapshot: Array<{ id: number; tmuxTarget: string }> = [];
        const resolvePrimaryTaskWindows = (): Array<{ taskId: number; windowName: string; target: string; onDestroyed: () => void }> => {
          const rows = opts.windowRepo?.findByServerAndSession(request.params.name, request.params.session) ?? [];
          sessionRowSnapshot = rows.map((win) => ({ id: win.id, tmuxTarget: win.tmuxTarget }));
          const out: Array<{ taskId: number; windowName: string; target: string; onDestroyed: () => void }> = [];
          for (const win of rows) {
            if (win.taskId === null || !isPrimaryTaskWindow(win)) continue;
            const windowName = windowNameFromTarget(win.tmuxTarget);
            if (windowName) {
              out.push({
                taskId: win.taskId,
                windowName,
                target: win.tmuxTarget,
                onDestroyed: () => opts.windowRepo?.removeByServerAndTarget(request.params.name, win.tmuxTarget),
              });
            }
          }
          return out;
        };

        let outcome: KillOutcome;
        let handledTargets = new Set<string>();
        if (opts.destroySessionWindows) {
          const result = await opts.destroySessionWindows(
            resolvePrimaryTaskWindows,
            request.params.name,
            'window_killed_via_session_delete',
            () => tmux.killSession(srv, request.params.session),
          );
          outcome = result.outcome;
          handledTargets = result.handledTargets;
        } else {
          // No task-window-aware callback wired (e.g. minimal test setups) —
          // fall back to a plain, unlocked kill. Every window row (task-owned
          // or not) is still cleaned up unconditionally below on success —
          // Issue #28 third-party review, D-track fix 3: a row must never be
          // silently left behind just because no revoke callback was wired.
          // Capture the snapshot immediately before the kill (no lock exists
          // in this fallback path) so the by-id cleanup below still applies.
          resolvePrimaryTaskWindows();
          outcome = await resolveKillOutcome(tmux.killSession(srv, request.params.session));
        }

        if (!outcome.success) {
          return reply.status(500).send({ error: `kill-session failed: ${outcome.result.stderr || outcome.result.stdout}` });
        }
        notifySessionsChanged(request.params.name);

        // Clean up every remaining row (secondary task windows, project
        // windows, and — when destroySessionWindows wasn't used — the
        // primary task windows too) not already handled above. Deleted by
        // `id` from the pre-kill snapshot captured above — never by
        // re-fetching `findByServerAndSession` after the kill and matching on
        // `target`, which a reused tmux target can turn into deleting a
        // brand-new row (see sessionRowSnapshot's doc comment).
        for (const win of sessionRowSnapshot) {
          if (handledTargets.has(win.tmuxTarget)) continue;
          opts.windowRepo?.remove(win.id);
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

        const cleanupWindowRows = () => {
          opts.windowRepo?.removeByServerAndTarget(request.params.name, target);
          if (identity) {
            opts.windowRepo?.removeByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowName}`);
            opts.windowRepo?.removeByServerAndTarget(request.params.name, `${identity.sessionName}:${identity.windowIndex}`);
          }
        };

        const windowName = identity ? identity.windowName : windowNameFromTarget(target);
        let outcome: KillOutcome;
        if (windowRow && windowRow.taskId !== null && isPrimaryTaskWindow(windowRow) && windowName && opts.destroyPrimaryTaskWindow) {
          // Task-owned primary window: the kill itself, the reread-gated
          // revoke, and the row cleanup all run inside ONE per-task lock
          // (Issue #28 third-party review, second round) — see
          // `destroyPrimaryTaskWindow`'s doc comment for the race this
          // closes vs. a concurrent respawn.
          outcome = await opts.destroyPrimaryTaskWindow(
            windowRow.taskId,
            windowName,
            request.params.name,
            // Issue #28 third-party review, D-track fix 2: pass the
            // CANONICAL `windows` table target (always `session:windowName`
            // — see windowNameFromTarget's doc comment), not the raw
            // (possibly index-form, e.g. "session:2") URL param. This is the
            // same form `wrapWithSupervisor`/`issueLaunch` register the
            // supervisor launch under, so buildServer.ts's launch-expiry
            // pass-through can actually find it.
            windowRow.tmuxTarget,
            'window_killed_via_sessions_route',
            () => tmux.killWindow(srv, target),
            cleanupWindowRows,
          );
        } else {
          // resolveKillOutcome normalizes local (throws on failure) vs agent
          // (resolves with a non-zero code) transports into one verdict —
          // see its doc comment.
          outcome = await resolveKillOutcome(tmux.killWindow(srv, target));
          if (outcome.success) cleanupWindowRows();
        }
        if (!outcome.success) {
          return reply.status(500).send({ error: `kill-window failed: ${outcome.result.stderr || outcome.result.stdout}` });
        }
        notifySessionsChanged(request.params.name);
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
