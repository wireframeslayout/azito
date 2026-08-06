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
 * Task fields that reach the worker's prompt as free-form text (see
 * resolveTaskPromptVars.ts: task.title/description are interpolated
 * directly; task.targetBranch is interpolated directly into the `- PR
 * target branch: ...` line; task.baseBranch/task.workingDirectory feed
 * project.defaultBranch/projectServer.workingDirectory, which are also
 * interpolated directly). Every one of these is editable via PUT
 * /api/tasks/:id with no inputTrust restriction, so every one of them must
 * be covered by the approval fingerprint below — covering only
 * `description` would let an attacker rewrite any of the others post-
 * approval and have it reach the prompt unreviewed.
 *
 * Deliberately NOT included: task.skipPr and the push* template vars derived
 * from it (fixed strings selected by a boolean, not attacker-authored text),
 * task.planMarkdown (worker-authored, not task-input), selfReview counters
 * (numeric), and project.sidekickPrompt/unit.systemPrompt (not task fields).
 */
type ApprovableTaskFields = Pick<Task, 'title' | 'description' | 'targetBranch' | 'baseBranch' | 'workingDirectory'>;

/**
 * Deterministic fingerprint of the task fields an approval was granted for.
 * Not a security hash (collision resistance beyond "don't false-match on
 * edit" isn't a requirement here) — sha256 is used simply because Node ships
 * it and it's already the project's convention for content fingerprints.
 *
 * Fields are combined via JSON.stringify with an explicit, fixed key order
 * (not string concatenation): JSON.stringify escapes embedded quotes,
 * backslashes and control characters, and the object literal's key order is
 * fixed in source rather than derived from user input, so there is no
 * delimiter an attacker could inject to make content "move" from one field
 * into another and still hash-collide with a previously-approved fingerprint
 * (e.g. title="" + description="X" would serialize differently from
 * title="X" + description="").
 */
export function hashApprovedTaskFingerprint(task: ApprovableTaskFields): string {
  const normalized = JSON.stringify({
    title: task.title,
    description: task.description ?? '',
    targetBranch: task.targetBranch ?? '',
    baseBranch: task.baseBranch ?? '',
    workingDirectory: task.workingDirectory ?? '',
  });
  return createHash('sha256').update(normalized).digest('hex');
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
export function checkExecutionGate(task: ApprovableTaskFields & Pick<Task, 'inputTrust' | 'executionApprovedFingerprintHash'>, projectServer: ProjectServer | null): ExecutionGateResult {
  if (task.inputTrust !== 'untrusted') return { allowed: true };

  const policy = projectServer?.inputPolicy ?? FALLBACK_INPUT_POLICY;
  if (policy === 'deny') return { allowed: false, reason: 'denied' };
  // 'allow' is reserved for a future isolated execution profile and is not
  // reachable today — PUT /api/projects/:id/servers/:serverName rejects
  // setting it (see modules/projects/routes.ts) — but the check is kept
  // explicit rather than falling through, so this module stays correct the
  // day that profile ships and the API restriction is lifted.
  if (policy === 'allow') return { allowed: true };

  // manual-approval: allowed only if a human approved the CURRENT fingerprint
  // (title/description/targetBranch/baseBranch/workingDirectory — see
  // ApprovableTaskFields above).
  const currentHash = hashApprovedTaskFingerprint(task);
  if (task.executionApprovedFingerprintHash === currentHash) return { allowed: true };
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
 * /api/units/:id/follow-up, /api/tasks/:id/recover-session, and
 * /api/windows/:id/respawn. Kept in this module (not e.g. a routes-only
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
