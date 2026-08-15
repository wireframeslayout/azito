import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { ExecResult } from '../../servers/transport/ServerTransport';
import type { TmuxClient } from '../../tmux/TmuxClient';
import { resolveKillOutcome, type KillOutcome } from '../../tmux/killOutcome';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { ISOLATION_MASKED_ENV } from '../../../shared/auth/isolationMaskedEnv';
import type { Task } from '../Task';
import type { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';

/**
 * Mask-only counterpart to `TmuxClient.uiTokenEnvForServer` (Issue #29
 * review, 11th pass, Critical finding 1). `uiTokenEnvForServer` INJECTS the
 * hub's live UI token for non-isolated servers — the right behavior for the
 * manual-terminal callers it exists for (`sessions.ts`'s 3 manual
 * create-session/window/pane routes, `createPlainWindow` above), which are
 * deliberately handing an operator credential to a human-facing shell.
 *
 * `ensureSessionWithLock`'s TASK session-bootstrap window is not one of
 * those callers: task-owned windows get their env exclusively from
 * `TaskPaneEnvironmentService` (per-window task tokens), and Issue #28's
 * design explicitly keeps the hub's operator `AZITO_UI_TOKEN` out of a task
 * tmux SESSION's env — round 11 of this review switched
 * `ensureSessionWithLock` to call `uiTokenEnvForServer(freshServer)`
 * directly, which regressed exactly that: a non-isolated server's bootstrap
 * session (and therefore every window `new-window` adds to it afterwards,
 * via tmux session-env inheritance) was created with the full operator
 * token injected.
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
 * Bundles the two things {@link createRotatedWindow} and
 * {@link createSecondaryWindow} need to close the Issue #29 review (7th
 * pass) Important finding 1 gap: task-window (re)creation used to build its
 * env from whatever `ServerConfig` object the caller happened to be holding
 * — often resolved well before the call, and never re-checked against a
 * `PUT /api/servers/:name` isolation transition that may have committed in
 * the meantime. `serverIsolationMutex` is the SAME per-server-name mutex
 * `modules/servers/routes.ts`'s PUT handler and `modules/tmux/routes/
 * sessions.ts`'s manual window/pane routes already serialize the
 * false->true isolation transition against (see that mutex's own doc
 * comment) — task-window creation now queues behind (or ahead of, depending
 * on arrival order) the exact same transition through the exact same key,
 * and re-reads the server row from `serverRepo` only once it has actually
 * acquired the lock, so the env it builds can never straddle a transition
 * that committed mid-flight.
 */
export interface ServerIsolationLock {
  serverIsolationMutex: KeyedMutex;
  serverRepo: Pick<IServerRepository, 'findByName'>;
}

/**
 * Re-reads `serverName` from `lock.serverRepo` — callers use this ONLY from
 * inside `lock.serverIsolationMutex.withLock(serverName, ...)`, so the row
 * this returns reflects whatever the most recently COMMITTED PUT
 * /api/servers/:name transition left behind, never a snapshot racing it.
 * Throws rather than falling back to the caller's stale `ServerConfig` — a
 * server deleted between the caller resolving it and this lock actually
 * being acquired has no current row to build a trustworthy env from, and
 * silently reusing the stale one would defeat the whole point of this
 * refetch.
 */
function refetchServer(lock: ServerIsolationLock, serverName: string): ServerConfig {
  const fresh = lock.serverRepo.findByName(serverName);
  if (!fresh) {
    throw new Error(`Server ${serverName} was not found while (re)creating a task window — it may have been deleted mid-flight`);
  }
  return fresh;
}

/**
 * Shared "kill-then-rotate" operation (Issue #28 third-party review,
 * execute()/followUp() rollback-safety fix): the same order and rollback
 * WindowRespawnService.respawn() already established —
 *   1. confirm any pre-existing window this rotation replaces is actually
 *      gone (via {@link confirmOldWindowGone}), BEFORE the token is rotated
 *   2. only then build the new-generation env and create the window (via
 *      {@link createRotatedWindow}), rolling the freshly-issued generation
 *      back if creation fails
 * — factored out so execute(), followUp(), and respawn() share one
 * implementation instead of three copies that can individually drift (the
 * gap this fix closes: execute()/followUp() had step 1 as a best-effort,
 * unconditional-swallow `catch {}` with no gate on the rotation that
 * followed, and step 2 only rolled back a THROWN creation failure, not a
 * resolved-with-non-zero-exit-code one — see killOutcome.ts's doc comment
 * for why `TmuxClient.createWindow`/`createSession` can resolve "successfully"
 * with a non-zero code on an `agent`-type server).
 *
 * Every call site is expected to run its own step-1/step-2 span through
 * {@link runExclusiveForTask} for the task being rotated — see that
 * function's doc comment for the interleaving bug this closes — and to
 * route any rollback of the generation it issued through the `tokenId`
 * {@link createRotatedWindow} returns, not a blanket revoke-all.
 */

export interface KillTarget {
  target: string;
  kind: 'window' | 'pane';
}

/** One in-flight chain per taskId — see {@link runExclusiveForTask}. */
const taskRotationLocks = new Map<number, Promise<unknown>>();

/**
 * Serializes the "confirm old window gone → rotate token → create new
 * window → persist" sequence per task (Issue #28 third-party review, design
 * v3 §2: "タスク単位ロック下で発行→作成→有効化"). Without this, two
 * concurrent rotations for the SAME task (e.g. an `execute()` racing a
 * `respawn()` triggered from the UI) can interleave in a way per-token
 * revocation scoping alone does not fix:
 *
 *   1. call A issues generation 1 (`issueNextGeneration`)
 *   2. call B issues generation 2 — this REVOKES generation 1 as part of its
 *      own transaction, before A's window creation has even resolved
 *   3. A's `create()` (already in flight) succeeds and persists `tmuxWindow`
 *      pointing at generation 1's window — but generation 1 was just
 *      revoked in step 2, so the pane that just came up authenticates with
 *      a dead token
 *
 * Queuing every rotation for a given taskId through this function means
 * step 2 can only start once step 1's entire issue→create→persist sequence
 * has settled, so no in-flight generation is ever revoked out from under a
 * creation that is still relying on it. A single in-memory `Map<taskId,
 * Promise>` queue is sufficient (not a DB-backed lock): the hub is a single
 * process, and every rotation site already awaits this promise chain, so
 * there is no cross-process concurrency to coordinate.
 *
 * `fn`'s rejection is preserved on the returned promise; only the internal
 * queue chain swallows it (so a failed rotation doesn't leave every later
 * queued rotation for the same task permanently rejected). The map entry is
 * dropped once its chain is the last one queued and has settled, so a task
 * that stops rotating doesn't leak an entry forever.
 */
export function runExclusiveForTask<T>(taskId: number, fn: () => Promise<T>): Promise<T> {
  const prior = taskRotationLocks.get(taskId) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  taskRotationLocks.set(taskId, tail);
  tail.finally(() => {
    if (taskRotationLocks.get(taskId) === tail) taskRotationLocks.delete(taskId);
  });
  return run;
}

/**
 * Multi-task variant of {@link runExclusiveForTask} — serializes `fn`
 * against every one of `taskIds`' individual rotation queues at once (Issue
 * #28 third-party review, D-track fix 1). A whole-session kill
 * (`DELETE /api/servers/:name/sessions/:session`) can tear down several
 * tasks' primary windows in one tmux call; without this, that single kill
 * had to run OUTSIDE any per-task lock (there is no single `taskId` to lock
 * on), which reopened exactly the race `runExclusiveForTask` exists to
 * close: window listing happens, a concurrent respawn for one of the
 * affected tasks lands a brand-new window generation, then the session kill
 * destroys everything (old AND new) while the DB layer — reading the
 * pre-kill window listing — still thinks the new generation is a
 * still-current, still-live window and skips revoking it.
 *
 * Queuing `fn` onto ALL of `taskIds`' queues, not just one, closes that: no
 * rotation for ANY of those tasks can be mid-issue while the session kill's
 * "kill -> reread -> revoke -> cleanup" span is running, and conversely this
 * call cannot start until every one of those tasks' own in-flight rotations
 * (if any) have settled.
 *
 * `taskIds` are read in whatever order the caller passes (callers are
 * expected to pass them pre-sorted, e.g. ascending, purely so concurrent
 * multi-task callers observe a consistent acquisition order in logs/traces —
 * see the doc comment below for why this queue design has no actual
 * deadlock to order away). Duplicates are harmless (`Set`-deduped).
 *
 * Deadlock note: unlike a true acquire/release mutex — where two callers
 * locking the same two taskIds in opposite orders can deadlock each other
 * mid-acquisition — this queue only ever *appends* a callback to each
 * taskId's promise chain. Reading every prior tail (`Promise.all` below) and
 * writing every new tail back happens synchronously, in one script turn,
 * before this function returns control to the event loop; no other
 * `runExclusiveForTask`/`runExclusiveForTasks` call can interleave between
 * "read priors" and "write tails" for ANY of the taskIds involved. There is
 * therefore no possible partial-acquisition state — an ordering convention
 * is good hygiene (and is what the doc comment above asks callers for) but
 * is not, in this specific implementation, load-bearing for correctness.
 */
export function runExclusiveForTasks<T>(taskIds: number[], fn: () => Promise<T>): Promise<T> {
  const uniqueIds = [...new Set(taskIds)];
  if (uniqueIds.length === 0) return fn();

  const priors = uniqueIds.map((id) => taskRotationLocks.get(id) ?? Promise.resolve());
  const run = Promise.all(priors.map((p) => p.catch(() => undefined))).then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  for (const id of uniqueIds) {
    taskRotationLocks.set(id, tail);
  }
  tail.finally(() => {
    for (const id of uniqueIds) {
      if (taskRotationLocks.get(id) === tail) taskRotationLocks.delete(id);
    }
  });
  return run;
}

/**
 * Confirms `killTarget` (when non-null) is actually gone before returning.
 * `taskId` gates whether a still-alive target is fatal: a task-owned
 * rotation MUST NOT proceed with a live old window (Issue #28 finding — a
 * still-live pane would keep authenticating with the credential the
 * subsequent rotation is about to revoke), so it throws; a non-task window
 * (plain terminal respawn) has no credential to protect and is left to the
 * caller.
 */
export async function confirmOldWindowGone(
  tmux: Pick<TmuxClient, 'killWindow' | 'killPane'>,
  server: ServerConfig,
  killTarget: KillTarget | null,
  taskId: number | null,
): Promise<void> {
  if (!killTarget) return;
  const exec = killTarget.kind === 'window'
    ? tmux.killWindow(server, killTarget.target)
    : tmux.killPane(server, killTarget.target);
  // resolveKillOutcome normalizes local (throws on failure) vs agent
  // (resolves with a non-zero code) transports into one verdict — a bare
  // await/`.then(() => true, () => false)` here previously read an
  // agent-transport kill failure as success (Issue #28 third-party review).
  const outcome = await resolveKillOutcome(exec);
  if (taskId !== null && !outcome.success) {
    throw new Error(
      `Failed to kill ${killTarget.kind} ${killTarget.target} before rotating window; the task token was not rotated so the still-live pane stays authenticated`,
    );
  }
}

/**
 * Rotates the task's token (via `paneEnvService.buildEnvForNewWindow`) and
 * creates the new window generation via `create`. Rolls the just-issued
 * generation back (`revokeForDestroyedWindow`) if `create` either throws
 * (local transport) or resolves with a non-zero exit code (agent transport
 * — `TmuxClient.createWindow`/`createSession` never reject on the remote
 * command's own exit code). Callers must NOT persist the returned
 * `windowName` when this throws — the window was never actually created (or
 * its creation is not trustworthy), so there is nothing real to record.
 */
export async function createRotatedWindow(
  paneEnvService: TaskPaneEnvironmentService,
  lock: ServerIsolationLock,
  server: ServerConfig,
  task: Task,
  reasonOnFailure: string,
  create: (freshServer: ServerConfig, env: Record<string, string>) => Promise<{ result: ExecResult; windowName: string }>,
): Promise<{ windowName: string; env: Record<string, string>; tokenId: number; server: ServerConfig }> {
  // Issue #29 review (7th pass), Important finding 1: the entire
  // env-resolution -> `create()` span now runs inside
  // `lock.serverIsolationMutex.withLock(server.name, ...)` — the SAME mutex
  // key `PUT /api/servers/:name`'s isolation-transition handler and the
  // manual session/window/pane routes already serialize on (see
  // {@link ServerIsolationLock}'s doc comment) — and `server` is re-read
  // from `lock.serverRepo` only once the lock is actually held, then handed
  // to BOTH `buildEnvForNewWindow` and `create()` as `freshServer` (the
  // caller's own `server` argument is used only to select the mutex key,
  // never to build env or create the window from). Without this, a task
  // execution/respawn/restore path could resolve `env` from a `ServerConfig`
  // fetched well before this call, race a concurrent false->true isolation
  // PUT that commits in between, and still hand the freshly-created pane the
  // OLD (non-isolated) credential set — exactly the gap
  // `applyTokenMaskingOrCompat`'s isolation check exists to close, just with
  // the race moved one layer up from "which branch runs" to "which server
  // row the check itself runs against".
  return lock.serverIsolationMutex.withLock(server.name, async () => {
    const freshServer = refetchServer(lock, server.name);
    const { env, tokenId } = paneEnvService.buildEnvForNewWindow(task, freshServer);
    let created: { result: ExecResult; windowName: string };
    try {
      created = await create(freshServer, env);
    } catch (err) {
      // Revoke only the generation THIS call just issued (`tokenId`), never a
      // blanket revokeAllForTask — a concurrent rotation for the same task may
      // already have issued and persisted a newer generation by the time this
      // failure is handled (see runExclusiveForTask's doc comment for why
      // callers are expected to serialize rotations per task in the first
      // place; this scoping is the second, independent half of that fix).
      paneEnvService.revokeGeneration(tokenId, reasonOnFailure);
      throw err;
    }
    if (created.result.code !== 0) {
      paneEnvService.revokeGeneration(tokenId, reasonOnFailure);
      throw new Error(
        `Failed to create tmux window (exit ${created.result.code}): ${created.result.stderr || created.result.stdout}`,
      );
    }
    // `env` (Issue #28 review Critical finding) — returned so a caller that
    // (re)creates a MULTI-pane window can pass this exact env to every
    // subsequent split-window it does for the same window (TmuxClient.splitPane's
    // `extraEnv`): only the window's first pane inherits what new-window/
    // new-session's own `-e` set, so a later split-window must be told the same
    // env explicitly or it silently inherits the tmux SESSION's environment
    // instead (see splitPane's doc comment). `tokenId` is returned so a caller
    // that later needs to roll THIS generation back (rollbackWindowReference,
    // for a failure downstream of window creation) can do so precisely.
    // `server` (the freshly re-read row) is returned too, so a caller whose
    // OWN subsequent tmux calls (resolvePaneId, splitPane, ...) should keep
    // using the exact connection info this window was actually created with
    // can do so instead of falling back to its now-possibly-stale argument.
    return { windowName: created.windowName, env, tokenId, server: freshServer };
  });
}

/**
 * Secondary-window counterpart of {@link createRotatedWindow} (Issue #29
 * review, 7th pass, Important finding 1's own scope note: "secondary window
 * (buildEnvForSecondaryWindow) の呼び出し元も同様に確認して覆う"). No token
 * rotation/rollback happens here — {@link TaskPaneEnvironmentService.buildEnvForSecondaryWindow}'s
 * own doc comment covers why a secondary window never touches the task
 * token repository — but the isolation-freshness requirement is identical:
 * env is resolved from `server`, so it must be resolved from the same
 * lock-then-refetch span `createRotatedWindow` uses, not from a `server`
 * object the caller may have resolved before a concurrent isolation
 * transition committed.
 */
export async function createSecondaryWindow(
  paneEnvService: TaskPaneEnvironmentService,
  lock: ServerIsolationLock,
  server: ServerConfig,
  task: Task,
  create: (freshServer: ServerConfig, env: Record<string, string>) => Promise<{ result: ExecResult; windowName: string }>,
): Promise<{ windowName: string; env: Record<string, string>; server: ServerConfig }> {
  return lock.serverIsolationMutex.withLock(server.name, async () => {
    const freshServer = refetchServer(lock, server.name);
    const env = paneEnvService.buildEnvForSecondaryWindow(task, freshServer);
    const created = await create(freshServer, env);
    return { windowName: created.windowName, env, server: freshServer };
  });
}

/**
 * Non-task counterpart of {@link createSecondaryWindow} (Issue #29 review,
 * 9th pass, Important finding 1). A plain (non-task) window respawn/create
 * has no task token and no masked-secondary env to resolve — it only ever
 * needs {@link TmuxClient.uiTokenEnvForServer} — but the isolation-freshness
 * requirement is identical to both other branches: env must be built from a
 * server row re-read AFTER this lock is actually held, never from whatever
 * `server` the caller happened to be holding before queuing for the lock.
 * Before this helper existed, WindowRespawnService's non-task branch built
 * `uiTokenEnvForServer(server)` from the caller's own (possibly stale)
 * argument and created the window with no lock at all — a false->true
 * isolation PUT committing in between could leave a freshly-created
 * "isolated" window holding the old, unmasked UI token.
 */
export async function createPlainWindow(
  tmux: Pick<TmuxClient, 'uiTokenEnvForServer'>,
  lock: ServerIsolationLock,
  server: ServerConfig,
  create: (freshServer: ServerConfig, env: Record<string, string>) => Promise<{ result: ExecResult; windowName: string }>,
): Promise<{ windowName: string; env: Record<string, string>; server: ServerConfig }> {
  return lock.serverIsolationMutex.withLock(server.name, async () => {
    const freshServer = refetchServer(lock, server.name);
    const env = tmux.uiTokenEnvForServer(freshServer);
    const created = await create(freshServer, env);
    return { windowName: created.windowName, env, server: freshServer };
  });
}

/**
 * Session-bootstrap counterpart of {@link createRotatedWindow}/{@link
 * createSecondaryWindow}/{@link createPlainWindow} (Issue #29 review, 10th
 * pass, Critical finding 1). Every task-window creation path (`execute()`,
 * `TaskRestoreService.restore()`, and the project-server "ensure session"
 * bootstrap in `projects/routes.ts`) first checks whether the task's tmux
 * SESSION exists and, if not, creates a throwaway bootstrap window via
 * `createSession` — before that, each call site did this session-existence
 * check AND the `createSession` call itself OUTSIDE
 * `serverIsolationMutex.withLock`, against whatever `ServerConfig` it had
 * resolved earlier in the request, exactly the gap `createRotatedWindow` et
 * al. already close for the REAL task window created moments later. A
 * false->true isolation PUT committing in the window between "caller
 * resolved `server`" and "this session-bootstrap runs" meant the very first
 * window of a session — which sets the tmux SESSION's own environment,
 * inherited by every window `new-window` adds afterwards (see the callers'
 * own doc comments) — could still be built from the pre-transition,
 * non-isolated `uiTokenEnvForServer(server)` and leak the UI token into the
 * session env for every later window to inherit.
 *
 * Mirrors the other three helpers exactly: the whole
 * "listSessions -> (maybe) createSession" span runs inside
 * `lock.serverIsolationMutex.withLock(server.name, ...)`, `server` is
 * re-read from `lock.serverRepo` only once the lock is actually held, and
 * the fresh row is both what `createSession` is called with AND what is
 * returned — callers must use the returned `server`, not their own pre-lock
 * argument, for anything they do afterwards (starting with the real
 * task-window creation this bootstrap precedes).
 *
 * Issue #29 review, 11th pass, Critical finding 1: this bootstrap session is
 * a TASK session, not a manual-terminal one — it must never inject the live
 * operator UI token the way `uiTokenEnvForServer` does for non-isolated
 * servers (round 11 switched this function to call
 * `uiTokenEnvForServer(freshServer)` directly, which regressed exactly
 * that). Uses {@link isolationMaskForServer} instead, which only ever masks
 * (isolated -> the shared mask, non-isolated -> `{}`), never injects.
 */
export async function ensureSessionWithLock(
  tmux: Pick<TmuxClient, 'listSessions' | 'createSession'>,
  lock: ServerIsolationLock,
  server: ServerConfig,
  sessionName: string,
): Promise<{ created: boolean; server: ServerConfig }> {
  return lock.serverIsolationMutex.withLock(server.name, async () => {
    const freshServer = refetchServer(lock, server.name);
    const existingSessions = await tmux.listSessions(freshServer);
    const exists = existingSessions.some((s) => s.name === sessionName);
    if (!exists) {
      await tmux.createSession(freshServer, sessionName, { extraEnv: isolationMaskForServer(freshServer) });
      return { created: true, server: freshServer };
    }
    return { created: false, server: freshServer };
  });
}

/**
 * Shared "rollback kill → reference bookkeeping" operation (Issue #28
 * third-party review, second round: 3 rollback sites each independently
 * cleared their reference to the about-to-be-killed window BEFORE — or
 * regardless of — confirming the kill actually worked, so a kill failure
 * left a still-live, still-token-authenticated window with nothing in the
 * DB pointing at it). The one correct order, now enforced in one place
 * instead of 3 copies that can drift again:
 *
 *   1. resolve the kill outcome via {@link resolveKillOutcome} (already-gone
 *      counts as success — see its own doc comment)
 *   2. success (or already-gone): clear the caller's reference via
 *      `onGone` (e.g. `tmuxWindow: null`, removing the Window row) AND
 *      revoke the just-issued token generation — BOTH are always attempted
 *      (Issue #28 third-party review, second round): `onGone` throwing (a
 *      DB write failing, say) must not skip the revoke, or the just-killed
 *      window's generation is left valid forever with nothing in the DB
 *      pointing at it to ever clean it up — worse than either failure
 *      alone. Both errors are captured independently and NEITHER is allowed
 *      to silently replace the other (Issue #28 follow-up review: a prior
 *      version of this fix made a revoke failure log-only, so `onGone`
 *      succeeding alone reported the whole call as a success even though the
 *      just-killed window's credential was still live) — `onGone`'s error
 *      wins when both fail (it is the caller's own domain failure and the
 *      more actionable one; the revoke error is attached as its `cause` and
 *      also logged), otherwise a revoke-only failure now propagates on its
 *      own instead of being swallowed into a `console.warn`.
 *   3. failure: call `onStillAlive` — the caller MUST use this to keep (or
 *      create, if not yet persisted) a reference to the window, never to
 *      clear one — and do NOT revoke the generation, so a still-live pane
 *      keeps a valid token and stays discoverable for an operator to clean
 *      up later
 *
 * Mirrors each site's original `catch {}` around the kill itself — this
 * never throws on the kill/resolve path; callers keep deciding whether (and
 * how) to surface their own domain-specific rollback error.
 */
export async function rollbackWindowReference(
  killExec: Promise<ExecResult>,
  paneEnvService: TaskPaneEnvironmentService,
  tokenId: number,
  revokeReason: string,
  onGone: () => void,
  onStillAlive: () => void,
): Promise<KillOutcome> {
  const outcome = await resolveKillOutcome(killExec);
  if (outcome.success) {
    // Issue #28 third-party review, D-track fix 4: `onGone` and the revoke
    // below are both ALWAYS attempted (point 2 above), but a plain
    // `try { onGone() } finally { revoke() }` let a revoke failure silently
    // REPLACE onGone's error (a `finally` block's own throw always wins over
    // whatever was propagating) — the caller's actual domain failure (e.g. a
    // DB write) was lost and only the revoke's unrelated error surfaced
    // instead. Both are now caught independently: the revoke failure is
    // logged (never silently dropped) but never allowed to mask onGone's
    // error, which is rethrown below when present.
    let onGoneFailed = false;
    let onGoneError: unknown;
    try {
      onGone();
    } catch (err) {
      onGoneFailed = true;
      onGoneError = err;
    }
    let revokeFailed = false;
    let revokeError: unknown;
    try {
      // Scoped to the specific generation `createRotatedWindow` issued for
      // this window (see revokeGeneration's doc comment) — not a blanket
      // revokeAllForTask, which could otherwise revoke a newer, still-valid
      // generation a concurrent rotation for the same task already
      // persisted.
      paneEnvService.revokeGeneration(tokenId, revokeReason);
    } catch (err) {
      revokeFailed = true;
      revokeError = err;
    }
    if (onGoneFailed) {
      if (revokeFailed) {
        console.warn(`[WindowRotation] revokeGeneration ALSO failed for tokenId=${tokenId} after a confirmed kill (onGone failed too)`, revokeError);
        // Issue #28 third-party review, follow-up (batch-2) fix: the doc
        // comment above always promised the revoke error is "attached as
        // its cause", but this used to just log it — a caller inspecting
        // `err.cause` (rather than grepping console output) had no
        // structural way to learn the revoke also failed. Attached via the
        // standard `Error.cause` mechanism (Node >= 16.9) whenever
        // `onGoneError` is an `Error`; a non-Error throw (e.g. a caller that
        // `throw`s a plain string) has no `cause` slot to attach to, so this
        // degrades to the log-only behavior in that one edge case.
        if (onGoneError instanceof Error) {
          onGoneError.cause = revokeError;
        }
      }
      // onGone's error is the caller's own domain failure and always wins
      // over the revoke's (mirrors the pre-existing single-failure test
      // below) — thrown as-is (message/identity unchanged), not wrapped, so
      // callers keep matching on it the same way they did before this fix.
      throw onGoneError;
    }
    if (revokeFailed) {
      // onGone succeeded but the revoke did not — this must surface as a
      // failure of the whole call, not just a logged warning: a caller that
      // reads success here would wrongly believe the just-killed window's
      // token generation was revoked, when it is still live.
      console.warn(`[WindowRotation] revokeGeneration failed for tokenId=${tokenId} after a confirmed kill`, revokeError);
      throw new Error(
        `revokeGeneration failed for tokenId=${tokenId} after a confirmed kill (onGone succeeded): ${revokeError instanceof Error ? revokeError.message : String(revokeError)}`,
        { cause: revokeError },
      );
    }
  } else {
    onStillAlive();
  }
  return outcome;
}
