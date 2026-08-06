import type { Task } from '../Task';
import type { ProjectServer } from '../../projects/ProjectServer';

/**
 * Execution gate for untrusted-origin tasks (Issue #328).
 *
 * Separate from (and in addition to) PhaseLoopRunner's existing plan-approval
 * gate. That gate fires AFTER the planning worker has already run once with
 * secrets injected into its tmux window — for untrusted input, that is one
 * agent turn too late. This gate is checked BEFORE any worker is launched,
 * any tmux window is created, or any secret/worktree touches the task —
 * every call site is a thin wrapper that runs this check first and returns
 * without side effects when it fails (see ExecuteTaskUseCase.execute/followUp/
 * resumeStateMachine and TaskRestoreService.restore).
 *
 * `task.source` is deliberately never consulted — it is client-editable via
 * PUT /api/tasks/:id (used by /azt-link) and would let a task silently lift
 * its own gate. `task.inputTrust` is the only signal this module trusts.
 *
 * What this module hashes changed in the fifth review round (Issue #328):
 * it used to hash a hand-picked list of raw `tasks` table columns, and every
 * review round found one more field execution actually depends on that
 * wasn't on the list (title -> targetBranch/baseBranch/workingDirectory ->
 * unitId/serverName/branch/subagent config -> project.defaultUnitId /
 * Unit.systemPrompt / project_servers.workingDirectory, none of which are
 * even task columns). See ExecutionManifest.ts for the resolved-manifest
 * approach that replaced it — this file now only compares an
 * already-resolved manifest hash against the stored approval, it does not
 * compute the hash itself and does not read any repository (Resolve at the
 * Boundary: every call site resolves via ExecutionManifest.ts first).
 */

export type ExecutionGateResult =
  | { allowed: true }
  | { allowed: false; reason: 'denied' }
  | { allowed: false; reason: 'pending_approval' };

/** Default applied when no project_servers row exists for (task.projectId, serverName) yet. */
const FALLBACK_INPUT_POLICY: ProjectServer['inputPolicy'] = 'manual-approval';

/**
 * `projectServer` is the project_servers row for the task's resolved server,
 * or null when none exists yet (e.g. server never explicitly configured for
 * this project). A missing row is treated the same as an explicit
 * 'manual-approval' row (see FALLBACK_INPUT_POLICY) — the column's own DB
 * default — rather than as "no restriction": unlike other containment checks
 * in this codebase that fail open when nothing is configured (there is
 * nothing to be strict *about* yet), silently auto-running untrusted input
 * because a server was never configured would be a materially worse default
 * than asking a human once.
 *
 * `manifestHash` is the caller's already-computed
 * `hashExecutionManifest(resolveExecutionManifest(task, ...).manifest)`
 * (ExecutionManifest.ts) — this function does not resolve or hash it itself,
 * so it needs no repository access at all; every call site resolves the
 * manifest at its own boundary (Resolve at the Boundary) before calling in.
 */
export function checkExecutionGate(
  task: Pick<Task, 'inputTrust' | 'executionApprovedFingerprintHash'>,
  projectServer: ProjectServer | null,
  manifestHash: string,
): ExecutionGateResult {
  if (task.inputTrust !== 'untrusted') return { allowed: true };

  const policy = projectServer?.inputPolicy ?? FALLBACK_INPUT_POLICY;
  if (policy === 'deny') return { allowed: false, reason: 'denied' };
  // 'allow' is reserved for a future isolated execution profile and is not
  // reachable today — PUT /api/projects/:id/servers/:serverName rejects
  // setting it (see modules/projects/routes.ts) — but the check is kept
  // explicit rather than falling through, so this module stays correct the
  // day that profile ships and the API restriction is lifted.
  if (policy === 'allow') return { allowed: true };

  // manual-approval: allowed only if a human approved the CURRENT resolved
  // manifest (see ExecutionManifest.ts for what's covered and why).
  if (task.executionApprovedFingerprintHash === manifestHash) return { allowed: true };
  return { allowed: false, reason: 'pending_approval' };
}

/** Thrown by execution entry points when checkExecutionGate() denies outright ('deny' policy). */
export class ExecutionGateDeniedError extends Error {
  constructor(taskId: number) {
    super(`Task ${taskId}: execution denied by project server input policy (untrusted-origin task)`);
    this.name = 'ExecutionGateDeniedError';
  }
}

/** Thrown by execution entry points when checkExecutionGate() requires human approval. */
export class ExecutionGatePendingApprovalError extends Error {
  constructor(taskId: number) {
    super(`Task ${taskId}: execution requires approval (untrusted-origin task) — see POST /api/units/:id/approve-execution`);
    this.name = 'ExecutionGatePendingApprovalError';
  }
}

/**
 * Shared translation of the untrusted-input execution gate's thrown errors
 * (Issue #328) into HTTP responses. Used by every route that can trigger
 * ExecuteTaskUseCase/WindowRespawnService's enforceExecutionGate() or an
 * inline checkExecutionGate() re-throw: /api/units/:id/execute,
 * /api/units/:id/follow-up, /api/tasks/:id/recover-session,
 * /api/tasks/:id/restore, and /api/windows/:id/respawn. Kept in this module (not e.g. a routes-only
 * helper file) so it lives next to the error classes it translates and
 * stays reachable from both `tasks` and `windows` — `windows` already
 * depends on `tasks` (WindowRespawnService imports ExecutionGate directly),
 * so this doesn't introduce a new dependency-direction edge.
 *
 * Returns true when it handled the error (caller should stop/return),
 * false otherwise so the caller falls through to its own error handling.
 */
export function replyToExecutionGateError(err: unknown, reply: { status: (code: number) => { send: (body: unknown) => unknown } }): boolean {
  if (err instanceof ExecutionGatePendingApprovalError) {
    reply.status(409).send({ error: 'execution_pending_approval', message: err.message });
    return true;
  }
  if (err instanceof ExecutionGateDeniedError) {
    reply.status(403).send({ error: 'execution_denied', message: err.message });
    return true;
  }
  return false;
}
