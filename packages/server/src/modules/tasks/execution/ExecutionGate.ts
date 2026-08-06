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
 * Task fields covered by the approval fingerprint below.
 *
 * Inclusion criterion (apply this to any NEW field added to PUT
 * /api/tasks/:id — do not rely on the list below staying exhaustive by
 * inspection): a field belongs here if it is (a) settable via PUT
 * /api/tasks/:id, AND (b) it changes WHAT gets executed (content that
 * reaches a worker's prompt or a delegated subagent's launch instructions)
 * or WHERE/HOW it executes (which Unit, server, branch, or worktree/window
 * the run targets) — i.e. it changes the execution's content or its
 * conditions. A field that reaches the prompt but the human already
 * re-reviews at another mandatory gate does NOT need to be here either;
 * this module only covers what would otherwise reach an untrusted-origin
 * task's worker UNREVIEWED.
 *
 * Fields currently covered, and why each one qualifies:
 * - title, description: interpolated directly into the worker's prompt
 *   (resolveTaskPromptVars.ts).
 * - targetBranch: interpolated directly into the `- PR target branch: ...`
 *   prompt line.
 * - baseBranch, workingDirectory: feed project.defaultBranch /
 *   projectServer.workingDirectory, also interpolated directly into the
 *   prompt.
 * - unitId: selects the Unit (worker type/model, phase config, system
 *   prompt) the task runs under — changes WHAT executes entirely.
 * - serverName: selects WHERE the task executes, and — because the
 *   untrusted-input policy itself is a project_servers row keyed by
 *   (projectId, serverName) — which policy row applies to future gate
 *   checks. Re-pointing serverName after approval could move an approved
 *   task onto a host with a laxer (or no) input_policy.
 * - branch: the worktree branch to check out — determines which existing
 *   branch's contents the worker starts from.
 * - reviewSubagent, implementSubagent: `{enabled, provider, model}` — when
 *   `enabled`, `provider`/`model` are interpolated directly into the
 *   delegated subagent's launch instructions and intro text
 *   (PhasePromptRenderer.buildSubagentDelegationBlock: "このフェーズの${role}は、
 *   必ず ${config.provider}（${config.model}）のサブエージェントに委任してください"),
 *   and parseSubagentConfigInput only checks types, not that provider/model
 *   are from a known-safe set — this is attacker-controlled free text
 *   reaching a prompt exactly like description, just structured. Neither
 *   field is system-overwritten after the client sets it (unlike
 *   worktreePath below), so including it does not cause fingerprint drift.
 *
 * Deliberately NOT included, and why:
 * - task.skipPr: only selects between two fixed template strings
 *   (pushTaskDescription/pushRules/pushOutput), never attacker-authored
 *   text.
 * - task.planMarkdown: worker-authored output, not client-supplied input.
 * - selfReview counters/limits (selfReviewCount, selfReviewMaxAttempts):
 *   numeric loop-iteration controls, not prompt content or a run target;
 *   worst case is more iterations of an already-approved phase, not new
 *   content or a new destination.
 * - project.sidekickPrompt/unit.systemPrompt: not task fields at all.
 * - status, priority: workflow bookkeeping/ordering consumed by the state
 *   machine and UI, not read as an execution input by any prompt-building
 *   or targeting code path.
 * - tmux_window (Task.tmuxWindow): system-managed once a run starts
 *   (execute() always creates a fresh `task-<id>` window and ignores this
 *   field for naming); NOT covered by the fingerprint, but see
 *   Task.pendingOperation for how a stale/attacker-set value here is kept
 *   from redirecting a follow-up into an unrelated existing window
 *   (Issue #328 third-round review finding 2 — a targeting concern, but
 *   one addressed by tracking the pending *operation* rather than by
 *   fingerprinting the window name, since the window name churns on every
 *   run and isn't itself something a human reviews at approval time).
 * - source, sourceRef: grep-verified unused by every prompt-building/
 *   execution-targeting code path (modules/prompt, modules/tasks/execution)
 *   — used only for UI display and /azt-link. `source` is also already
 *   documented above as deliberately untrusted for gating purposes.
 * - changedFiles, prUrl: system-computed OUTPUTS written back to the task
 *   after a phase completes (git diff / PR lookup); never read as input
 *   before or during a run.
 * - requirePlanApproval: can only be strengthened (true), never weakened,
 *   for an untrusted task — enforced independently by the PUT handler
 *   itself (`PUT /api/tasks/:id` rejects `require_plan_approval: false` on
 *   an untrusted task), so there is no dangerous direction left for the
 *   fingerprint to guard against.
 * - worktreePath, worktreeBranch: settable via PUT, and worktreePath IS read
 *   as a follow-up target directory (ExecuteTaskUseCase.followUp) — but both
 *   are also unconditionally overwritten by the system itself every time a
 *   worktree is (re)created (ExecuteTaskUseCase.execute/TaskRestoreService.
 *   restore write the freshly-created worktree's actual path/branch back
 *   onto the task right after the gate check that approved the run). Adding
 *   them to the fingerprint would make every approval self-invalidate the
 *   moment the run it approved actually creates a worktree — the opposite of
 *   "approve once, resume across follow-ups" — while the actual attack
 *   surface (a client picking an arbitrary followUpDir before the system
 *   overwrites it) is already closed by the pre-existing containment check
 *   (assertDirectoryContained against projectServer.workingDirectory) that
 *   ExecuteTaskUseCase.followUp applies to worktreePath before using it,
 *   independent of this gate.
 */
type ApprovableTaskFields = Pick<
  Task,
  'title' | 'description' | 'targetBranch' | 'baseBranch' | 'workingDirectory' | 'unitId' | 'serverName' | 'branch' | 'reviewSubagent' | 'implementSubagent'
>;

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
    unitId: task.unitId ?? null,
    serverName: task.serverName ?? '',
    branch: task.branch ?? '',
    reviewSubagent: task.reviewSubagent ?? null,
    implementSubagent: task.implementSubagent ?? null,
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
  // (see ApprovableTaskFields above for the full field list and inclusion
  // criteria).
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
