import type { IServerRepository, ServerConfig } from './Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import { KeyedMutex } from '../../shared/keyedMutex';
import { ISOLATION_MASKED_ENV } from '../../shared/auth/isolationMaskedEnv';

// Issue #29 review (independent QC), M-3: this file used to live in
// `modules/tasks/execution/WindowRotation.ts` — an upper-layer module — even
// though none of what it exports (`ensureSessionWithLock`, `withServerLock`,
// `ServerIsolationLock`, `refetchServer`, `isolationMaskForServer`,
// `ServerSnapshotMismatchError`) touches anything task-specific: every
// dependency below is `modules/tmux`/`modules/servers` (the base layer,
// which the dependency-cruiser config already allows to reference each
// other) plus `shared/`. Its only actual reason for living in `tasks/
// execution` was historical (it grew alongside `createRotatedWindow` et al,
// which DO need `Task`/`TaskPaneEnvironmentService` and legitimately stay
// there). Keeping it there forced `modules/projects/routes.ts` — itself an
// upper-layer module with its own documented stance that it "cannot import
// from tasks" (see `ProjectServer.ts`'s `resolveInputPolicy` doc comment) —
// to import `ensureSessionWithLock`/`ServerIsolationLock` from `tasks/
// execution/WindowRotation` anyway, directly contradicting that stance.
// Moved here (base layer, servers⇄tmux pair) so `projects/routes.ts` can
// depend on it without ever touching `tasks/`; `WindowRotation.ts` re-exports
// everything below unchanged so its own existing importers (`tasks/*`,
// `modules/windows/WindowRespawnService.ts`) don't need to change their
// import paths.

/**
 * Mask-only counterpart to `TmuxClient.uiTokenEnvForServer` (Issue #29
 * review, 11th pass, Critical finding 1). `uiTokenEnvForServer` INJECTS the
 * hub's live UI token for non-isolated servers — the right behavior for the
 * manual-terminal callers it exists for (`sessions.ts`'s 3 manual
 * create-session/window/pane routes, `createPlainWindow` in WindowRotation.ts),
 * which are deliberately handing an operator credential to a human-facing
 * shell.
 *
 * `ensureSessionWithLock`'s TASK session-bootstrap window is not one of
 * those callers: task-owned windows get their env exclusively from
 * `TaskPaneEnvironmentService` (per-window task tokens), and Issue #28's
 * design explicitly keeps the hub's operator `AZITO_UI_TOKEN` out of a task
 * tmux SESSION's env.
 *
 * This helper only ever MASKS, never injects: isolated servers get the
 * shared {@link ISOLATION_MASKED_ENV} (explicit empty values are required to
 * override a token an existing session's env may already carry — see
 * `TaskPaneEnvironmentService`'s doc comment), non-isolated servers get `{}`
 * (no keys touched at all — the task-scoped env layered on afterwards is the
 * only source of a token task windows ever see).
 */
export function isolationMaskForServer(server: Pick<ServerConfig, 'isolationIntent'>): Record<string, string> {
  return server.isolationIntent ? { ...ISOLATION_MASKED_ENV } : {};
}

/**
 * Bundles the two things task-window (re)creation and the project-session
 * bootstrap need to close the Issue #29 review (7th pass) Important finding
 * 1 gap: task-window (re)creation used to build its env from whatever
 * `ServerConfig` object the caller happened to be holding — often resolved
 * well before the call, and never re-checked against a `PUT
 * /api/servers/:name` isolation transition that may have committed in the
 * meantime. `serverIsolationMutex` is the SAME per-server-name mutex
 * `modules/servers/routes.ts`'s PUT handler and `modules/tmux/routes/
 * sessions.ts`'s manual window/pane routes already serialize the
 * false->true isolation transition against (see that mutex's own doc
 * comment) — window/session (re)creation now queues behind (or ahead of,
 * depending on arrival order) the exact same transition through the exact
 * same key, and re-reads the server row from `serverRepo` only once it has
 * actually acquired the lock, so the env it builds can never straddle a
 * transition that committed mid-flight.
 */
export interface ServerIsolationLock {
  serverIsolationMutex: KeyedMutex;
  serverRepo: Pick<IServerRepository, 'findByName'>;
}

/**
 * Security-relevant `ServerConfig` fields (Issue #29 review, 12th pass,
 * Critical finding 1). Manifest resolution, the execution approval gate, and
 * the resource/containment checks in `ExecuteTaskUseCase`/`TaskRestoreService`/
 * `WindowRespawnService` all run against the `server` row the caller resolved
 * BEFORE queuing for `serverIsolationMutex` — but `refetchServer` below
 * always hands the window-creation callback whatever row is CURRENT once the
 * lock is actually acquired. If a `PUT /api/servers/:name` commits in the
 * (however small) window between "caller's checks ran" and "this lock was
 * acquired", every caller used to silently adopt the newer row and build the
 * window's env/target from it — meaning a task could end up executing
 * against an endpoint that was never the one the approval gate evaluated, or
 * with a secret injected that an isolation transition should have excluded.
 * These are exactly the fields a change to which invalidates whatever the
 * caller already checked; anything else (agentVersion,
 * isolationVerifiedAt/Report, sshHostFingerprint, createdAt, ...) is fine to
 * silently pick up fresh, same as before.
 */
const SECURITY_SNAPSHOT_FIELDS = ['isolationIntent', 'type', 'host', 'sshHost', 'agentPort', 'agentToken', 'muxRuntime'] as const satisfies readonly (keyof ServerConfig)[];

/** Thrown by {@link refetchServer} when `enforceSnapshot` is true and the row that committed while the caller was queued for the lock differs from the one its pre-lock checks ran against. */
export class ServerSnapshotMismatchError extends Error {
  constructor(serverName: string) {
    super(
      `Server ${serverName} の設定が実行準備中に変更された（isolation/接続設定が承認・チェック時点のものと一致しない）。承認済みでないエンドポイントや誤ったシークレットセットで実行することを避けるため中断した。再実行せよ。`,
    );
    this.name = 'ServerSnapshotMismatchError';
  }
}

/**
 * Re-reads `expected.name` from `lock.serverRepo` — callers use this ONLY
 * from inside `lock.serverIsolationMutex.withLock(expected.name, ...)`, so
 * the row this returns reflects whatever the most recently COMMITTED PUT
 * /api/servers/:name transition left behind, never a snapshot racing it.
 * Throws rather than falling back to the caller's stale `ServerConfig` — a
 * server deleted between the caller resolving it and this lock actually
 * being acquired has no current row to build a trustworthy env from, and
 * silently reusing the stale one would defeat the whole point of this
 * refetch.
 *
 * `enforceSnapshot` (Issue #29 review, 12th pass, Critical finding 1):
 * when true (the default every exported helper below uses), `expected` is
 * treated not just as "which row to re-read" but as the exact snapshot the
 * caller's own approval gate / resource / containment checks already ran
 * against — if the freshly re-read row disagrees on any
 * {@link SECURITY_SNAPSHOT_FIELDS}, this throws {@link ServerSnapshotMismatchError}
 * instead of silently adopting the newer row. The one caller that
 * legitimately wants the old "adopt whatever is current" behavior
 * (`projects/routes.ts`'s server-bootstrap `ensureSessionWithLock` call,
 * which sits outside the task approval boundary entirely — see that call
 * site's own comment) passes `enforceSnapshot: false`.
 */
function refetchServer(lock: ServerIsolationLock, expected: ServerConfig, enforceSnapshot: boolean): ServerConfig {
  const fresh = lock.serverRepo.findByName(expected.name);
  if (!fresh) {
    throw new Error(`Server ${expected.name} was not found while (re)creating a task window — it may have been deleted mid-flight`);
  }
  if (enforceSnapshot && SECURITY_SNAPSHOT_FIELDS.some((field) => expected[field] !== fresh[field])) {
    throw new ServerSnapshotMismatchError(expected.name);
  }
  return fresh;
}

/**
 * Standalone "acquire the per-server isolation lock, refetch, snapshot-check"
 * primitive (Issue #29 review, 14th pass, Important finding 1). Every
 * `create*` helper in `WindowRotation.ts` already runs this exact sequence
 * internally, but only around its OWN `create()` call — a caller that needs
 * to run something else (most notably: killing the window a rotation is
 * about to replace) BEFORE the window-creation span, and have that
 * "something else" also benefit from the lock+snapshot-check, had no way to
 * get at the fresh, snapshot-verified `ServerConfig` without either
 * duplicating `refetchServer`'s logic or acquiring the lock twice (once for
 * the kill, once for `create*` — reentrant on `KeyedMutex`, but leaves a
 * window between the two acquisitions where a `PUT /api/servers/:name`
 * could commit and the kill's own server row goes stale again).
 *
 * Not reentrant: callers already holding this same per-server lock (e.g.
 * from inside another `withServerLock`/`create*` call) must not call this
 * again for the same server — `KeyedMutex.withLock` would deadlock on a
 * naive reentrant call from the same async chain since it is not designed as
 * a reentrant primitive.
 */
export async function withServerLock<T>(
  lock: ServerIsolationLock,
  server: ServerConfig,
  enforceSnapshot: boolean,
  fn: (freshServer: ServerConfig) => Promise<T>,
): Promise<T> {
  return lock.serverIsolationMutex.withLock(server.name, async () => {
    const freshServer = refetchServer(lock, server, enforceSnapshot);
    return fn(freshServer);
  });
}

/**
 * Session-bootstrap counterpart of `createRotatedWindow`/`createSecondaryWindow`/
 * `createPlainWindow` (Issue #29 review, 10th pass, Critical finding 1).
 * Every task-window creation path (`execute()`, `TaskRestoreService.restore()`,
 * and the project-server "ensure session" bootstrap in `projects/routes.ts`)
 * first checks whether the task's tmux SESSION exists and, if not, creates a
 * throwaway bootstrap window via `createSession` — before that, each call
 * site did this session-existence check AND the `createSession` call itself
 * OUTSIDE `serverIsolationMutex.withLock`, against whatever `ServerConfig` it
 * had resolved earlier in the request, exactly the gap `createRotatedWindow`
 * et al. already close for the REAL task window created moments later. A
 * false->true isolation PUT committing in the window between "caller
 * resolved `server`" and "this session-bootstrap runs" meant the very first
 * window of a session — which sets the tmux SESSION's own environment,
 * inherited by every window `new-window` adds afterwards — could still be
 * built from the pre-transition, non-isolated `uiTokenEnvForServer(server)`
 * and leak the UI token into the session env for every later window to
 * inherit.
 *
 * Mirrors `withServerLock`: the whole "listSessions -> (maybe) createSession"
 * span runs inside `lock.serverIsolationMutex.withLock(server.name, ...)`,
 * `server` is re-read from `lock.serverRepo` only once the lock is actually
 * held, and the fresh row is both what `createSession` is called with AND
 * what is returned — callers must use the returned `server`, not their own
 * pre-lock argument, for anything they do afterwards (starting with the real
 * task-window creation this bootstrap precedes).
 *
 * Issue #29 review, 11th pass, Critical finding 1: this bootstrap session is
 * a TASK session, not a manual-terminal one — it must never inject the live
 * operator UI token the way `uiTokenEnvForServer` does for non-isolated
 * servers. Uses {@link isolationMaskForServer} instead, which only ever masks
 * (isolated -> the shared mask, non-isolated -> `{}`), never injects.
 *
 * `enforceSnapshot` (Issue #29 review, 12th pass, Critical finding 1)
 * defaults to true, matching every other caller of `withServerLock`:
 * `server` is treated as the exact row the caller's approval gate / resource
 * / containment checks already ran against, and a refetch that disagrees on
 * a security-relevant field aborts instead of silently adopting the newer
 * row (see `refetchServer`'s doc comment). The one exception is
 * `projects/routes.ts`'s server-bootstrap call, which sits outside the task
 * execution-approval boundary entirely (it is not preceded by any
 * approval/manifest/resource check to invalidate) and deliberately keeps the
 * old "adopt whatever is current" behavior by passing `enforceSnapshot: false`.
 */
export async function ensureSessionWithLock(
  tmux: Pick<TmuxClient, 'listSessions' | 'createSession'>,
  lock: ServerIsolationLock,
  server: ServerConfig,
  sessionName: string,
  enforceSnapshot = true,
): Promise<{ created: boolean; server: ServerConfig }> {
  return lock.serverIsolationMutex.withLock(server.name, async () => {
    const freshServer = refetchServer(lock, server, enforceSnapshot);
    const existingSessions = await tmux.listSessions(freshServer);
    const exists = existingSessions.some((s) => s.name === sessionName);
    if (!exists) {
      await tmux.createSession(freshServer, sessionName, { extraEnv: isolationMaskForServer(freshServer) });
      return { created: true, server: freshServer };
    }
    return { created: false, server: freshServer };
  });
}
