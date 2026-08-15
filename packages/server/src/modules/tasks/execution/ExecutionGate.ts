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

/**
 * `policy` is the ALREADY-RESOLVED effective input policy for the task's
 * resolved server — every call site computes it via
 * `resolveInputPolicy(projectServer)` (projects/ProjectServer.ts) before
 * calling in here. This function never reads a project_servers row itself
 * (Issue #328 design constraint: `checkExecutionGate` stays a pure
 * comparator with no repository access — Issue #29 Step 0 moved the
 * "missing row -> manual-approval" fallback out of this file and into
 * `resolveInputPolicy`, the single place that now applies it, replacing a
 * second, independently-hardcoded copy of the same default that used to
 * live in projects/routes.ts's PUT handler).
 *
 * A missing project_servers row resolves (via `resolveInputPolicy`) to
 * 'manual-approval' — the column's own DB default — rather than to "no
 * restriction": unlike other containment checks in this codebase that fail
 * open when nothing is configured (there is nothing to be strict *about*
 * yet), silently auto-running untrusted input because a server was never
 * configured would be a materially worse default than asking a human once.
 *
 * `manifestHash` is the caller's already-computed
 * `hashExecutionManifest(resolveExecutionManifest(task, ...).manifest)`
 * (ExecutionManifest.ts) — this function does not resolve or hash it itself,
 * so it needs no repository access at all; every call site resolves the
 * manifest at its own boundary (Resolve at the Boundary) before calling in.
 *
 * `task.pendingOperation` is checked BEFORE the hash comparison (third-party
 * review round, "approved hash survives a block"): a non-null
 * `pendingOperation` means a block is currently outstanding for this task
 * (it is written exclusively by {@link recordExecutionGateBlock} call sites
 * and cleared exclusively by {@link consumePendingApproval} — see Task.ts's
 * own doc comment on the field), and that fact must win over a stale
 * `executionApprovedFingerprintHash` that happens to match the CURRENT
 * manifest again. Without this, the sequence (1) approve at hash H, (2) edit
 * to hash H2 -> gate blocks, records pendingOperation, leaves the old
 * approved hash H untouched, (3) edit back to H -> a naive hash-only
 * comparison would read `executionApprovedFingerprintHash === manifestHash`
 * as "approved" and allow execution while `pendingOperation` is still set —
 * running a task a human has NOT actually approved in its current
 * (reverted) form, and leaving `pending_operation IS NULL`'s invariant
 * broken (a later, real drift could never record a fresh block, since one is
 * already "outstanding"). Approval (`consumePendingApproval`) clears
 * `pendingOperation` in the SAME atomic UPDATE that records the new approved
 * hash, so by the time a human's approval is visible to this function,
 * `pendingOperation` is already NULL again — this check never fires for a
 * task that was genuinely just approved.
 */
export function checkExecutionGate(
  task: Pick<Task, 'inputTrust' | 'executionApprovedFingerprintHash' | 'pendingOperation'>,
  policy: ProjectServer['inputPolicy'],
  manifestHash: string,
): ExecutionGateResult {
  if (task.inputTrust !== 'untrusted') return { allowed: true };

  if (policy === 'deny') return { allowed: false, reason: 'denied' };
  // 'allow' is reserved for a future isolated execution profile and is not
  // reachable today — PUT /api/projects/:id/servers/:serverName rejects
  // setting it (see modules/projects/routes.ts) — but the check is kept
  // explicit rather than falling through, so this module stays correct the
  // day that profile ships and the API restriction is lifted.
  if (policy === 'allow') return { allowed: true };

  // A block already outstanding always wins over a hash match — see this
  // function's own doc comment above for the exact stale-approval sequence
  // this guards against.
  if (task.pendingOperation !== null) return { allowed: false, reason: 'pending_approval' };

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
    super(`Task ${taskId}: execution requires approval (untrusted-origin task) — see POST /api/tasks/:id/approve-execution`);
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
