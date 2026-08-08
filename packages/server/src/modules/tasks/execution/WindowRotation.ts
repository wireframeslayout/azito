import type { ServerConfig } from '../../servers/Server';
import type { ExecResult } from '../../servers/transport/ServerTransport';
import type { TmuxClient } from '../../tmux/TmuxClient';
import { resolveKillOutcome, type KillOutcome } from '../../tmux/killOutcome';
import type { Task } from '../Task';
import type { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';

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
  server: ServerConfig,
  task: Task,
  reasonOnFailure: string,
  create: (env: Record<string, string>) => Promise<{ result: ExecResult; windowName: string }>,
): Promise<{ windowName: string; env: Record<string, string>; tokenId: number }> {
  const { env, tokenId } = paneEnvService.buildEnvForNewWindow(task, server);
  let created: { result: ExecResult; windowName: string };
  try {
    created = await create(env);
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
  return { windowName: created.windowName, env, tokenId };
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
 *      alone. `onGone`'s error still propagates (via `finally`, not a
 *      swallowed `catch {}`) once the revoke has also been attempted.
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
    try {
      onGone();
    } finally {
      // Always attempted, even if `onGone` threw above — see the doc
      // comment's point 2. Scoped to the specific generation
      // `createRotatedWindow` issued for this window (see
      // revokeGeneration's doc comment) — not a blanket revokeAllForTask,
      // which could otherwise revoke a newer, still-valid generation a
      // concurrent rotation for the same task already persisted.
      paneEnvService.revokeGeneration(tokenId, revokeReason);
    }
  } else {
    onStillAlive();
  }
  return outcome;
}
