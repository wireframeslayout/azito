import { createHash } from 'crypto';
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
 */

export type ExecutionGateResult =
  | { allowed: true }
  | { allowed: false; reason: 'denied' }
  | { allowed: false; reason: 'pending_approval' };

/** Default applied when no project_servers row exists for (task.projectId, serverName) yet. */
const FALLBACK_INPUT_POLICY: ProjectServer['inputPolicy'] = 'manual-approval';

/**
 * Deterministic fingerprint of the task description an approval was granted
 * for. Not a security hash (collision resistance beyond "don't false-match
 * on edit" isn't a requirement here) — sha256 is used simply because Node
 * ships it and it's already the project's convention for content fingerprints.
 */
export function hashTaskDescription(description: string | null): string {
  return createHash('sha256').update(description ?? '').digest('hex');
}

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
 */
export function checkExecutionGate(task: Pick<Task, 'inputTrust' | 'description' | 'executionApprovedDescriptionHash'>, projectServer: ProjectServer | null): ExecutionGateResult {
  if (task.inputTrust !== 'untrusted') return { allowed: true };

  const policy = projectServer?.inputPolicy ?? FALLBACK_INPUT_POLICY;
  if (policy === 'deny') return { allowed: false, reason: 'denied' };
  // 'allow' is reserved for a future isolated execution profile and is not
  // reachable today — PUT /api/projects/:id/servers/:serverName rejects
  // setting it (see modules/projects/routes.ts) — but the check is kept
  // explicit rather than falling through, so this module stays correct the
  // day that profile ships and the API restriction is lifted.
  if (policy === 'allow') return { allowed: true };

  // manual-approval: allowed only if a human approved the CURRENT description.
  const currentHash = hashTaskDescription(task.description);
  if (task.executionApprovedDescriptionHash === currentHash) return { allowed: true };
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
