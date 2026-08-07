import { TaskStatus } from './TaskStatus';
import type { SubagentConfig } from '../units/Unit';

export interface Task {
  id: number;
  projectId: number;
  /** Unit override for this task; falls back to project.defaultUnitId when null. */
  unitId: number | null;
  /** Execution server override for this task; falls back to the project's first project_servers row when null. */
  serverName: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  currentPhase: string | null;
  selfReviewCount: number;
  priority: number;
  tmuxWindow: string | null;
  selfReviewMaxAttempts: number | null;
  requirePlanApproval: boolean;
  source: 'local' | 'github' | 'gitlab';
  sourceRef: string | null;
  /**
   * Immutable-by-client trust level (Issue #328). Unlike `source`, this is
   * never accepted from POST/PUT /api/tasks request bodies — it is the only
   * signal the execution gate (modules/tasks/execution/ExecutionGate.ts)
   * relies on to tell external-origin tasks apart, precisely because
   * `source` is freely rewritable by /azt-link and thus cannot be trusted
   * for authorization. Only server-side code paths (import-issue) may set
   * 'untrusted'; nothing may transition 'untrusted' back to 'trusted'.
   */
  inputTrust: 'trusted' | 'untrusted';
  /**
   * Fingerprint (see ExecutionManifest.hashExecutionManifest) of the
   * RESOLVED execution manifest — not raw task columns — that a human most
   * recently approved for unattended execution while input_trust =
   * 'untrusted': the resolved Unit's content, the resolved server's
   * project_servers config, resolved base/target/work branches, task
   * title/description, and resolved subagent config (see
   * ExecutionManifest.ts's module doc comment for the authoritative list and
   * inclusion criteria — it covers more than this row alone, e.g.
   * project.defaultUnitId and the resolved Unit's systemPrompt). Null means
   * "never approved" or "the resolved manifest is stale" (something it
   * covers changed since, on the task OR elsewhere it resolves through). See
   * ExecutionGate.checkExecutionGate for the comparison.
   */
  executionApprovedFingerprintHash: string | null;
  /**
   * Which operation the execution gate blocked and must be resumed (not
   * re-inferred) once a human approves (Issue #328 third/fourth/seventh-round
   * review): see modules/tasks/execution/ExecutionApprovalDecision.ts's approve-execution handler. Set
   * immediately before the gate throws and cleared once approval consumes
   * it. NULL means "no pending operation" — the normal state, and also the
   * fallback the approval handler uses for any row that predates this
   * column (see migration 059's comment; there is no such row in practice,
   * 059 has never shipped).
   *
   * **Per-operation approval transition table** (seventh-round review finding
   * 1/2 — a per-operation table, kept here so a new write site is forced to
   * fill in all four columns instead of copy-pasting the nearest existing
   * `if` branch and silently missing one):
   *
   * | pendingOperation           | status BEFORE the gate stopped it (-> pendingOperationPriorStatus) | on APPROVE                                                        | on DENY                          | on approved-run FAILURE |
   * |-----------------------------|----------------------------------------------------------------------|--------------------------------------------------------------------|-----------------------------------|--------------------------|
   * | 'execute'                  | whatever it was pre-run (e.g. 'open')                                 | run execute(); execute() manages status itself                    | 'failed'                          | 'failed'                 |
   * | 'resume'                   | whatever it was mid-run (e.g. 'running')                              | run resumeStateMachine(); it manages status itself                | 'failed'                          | 'failed'                 |
   * | 'resume_await_answer'      | 'waiting_input' / 'review'                                            | restore to pendingOperationPriorStatus — NO auto resume; the human must resubmit the SAME answers to POST /api/tasks/:id/answer (they were never persisted) | 'failed' | n/a (nothing is run) |
   * | 'resume_await_plan_review' | 'phase_review'                                                        | restore to pendingOperationPriorStatus — NO auto resume; the human must resubmit the SAME decision to POST /api/units/:id/approve-plan (feedback was never persisted) | 'failed' | n/a (nothing is run) |
   * | 'restore'                  | 'archived'                                                            | run restore(); restore() sets 'open' on success itself             | 'archived' (not 'failed' — nothing ran) | 'failed' |
   * | 'respawn'                  | whatever the window's task had                                       | run respawn(); on success restore to pendingOperationPriorStatus  | 'failed'                          | 'failed'                 |
   * | 'recover_session_legacy'   | whatever the task had                                                 | run resumeLegacySession(); on success restore to pendingOperationPriorStatus | 'failed'                | 'failed'                 |
   *
   * `'resume_await_answer'`/`'resume_await_plan_review'` exist specifically
   * because /api/tasks/:id/answer and /api/units/:id/approve-plan check the
   * gate BEFORE persisting the human's answers/feedback (so a block doesn't
   * silently discard them) — the previous single 'resume' value made the
   * approval handler auto-invoke resumeStateMachine() for these too, which
   * resumed the task WITHOUT ever delivering the answers/feedback (seventh-
   * round review symptom A). Every other 'resume' call site (resumeStateMachine()
   * itself, PhaseLoopRunner continuation, RecoverStuckTasksUseCase) has no
   * ephemeral human input at risk, so it keeps auto-resuming under the plain
   * 'resume' value.
   *
   * Write-site catalogue (every gate that can set this MUST be listed here
   * — a value added without a matching writer is exactly how the fourth-
   * round review's "forgotten wiring" bug happened, silently falling back
   * to the wrong resumed operation):
   * - 'execute'  — ExecuteTaskUseCase.enforceExecutionGate (execute() entry)
   * - 'resume'   — ExecuteTaskUseCase.enforceExecutionGate (followUp()/
   *                resumeStateMachine() entries reached WITHOUT a route-level
   *                pre-check, e.g. RecoverStuckTasksUseCase)
   * - 'resume_await_answer'      — ExecuteTaskUseCase.enforceExecutionGate,
   *                passed explicitly by POST /api/tasks/:id/answer's
   *                pre-check (modules/tasks/routes.ts)
   * - 'resume_await_plan_review' — ExecuteTaskUseCase.enforceExecutionGate,
   *                passed explicitly by POST /api/units/:id/approve-plan's
   *                pre-check (modules/units/routes.ts), both its
   *                approved-with-feedback and rejected-with-feedback branches
   * - 'restore'  — TaskRestoreService.restore
   * - 'respawn'  — WindowRespawnService.enforceExecutionGate (respawn()
   *                entry); pendingOperationWindowId is set alongside this
   *                value and MUST be used to resume it (see below)
   * - 'recover_session_legacy' — WindowRespawnService.enforceExecutionGate
   *                (resumeLegacySession() entry, the pre-migration-034
   *                window-less fallback used by POST /api/tasks/:id/
   *                recover-session)
   */
  pendingOperation:
    | 'execute'
    | 'resume'
    | 'resume_await_answer'
    | 'resume_await_plan_review'
    | 'restore'
    | 'respawn'
    | 'recover_session_legacy'
    | null;
  /**
   * The Window row id to resume when pendingOperation === 'respawn' — a
   * respawn-blocked task has no other reliable way to recover which window
   * was being respawned (unlike 'execute'/'resume'/'restore', which
   * re-resolve their target entirely from task/project fields).
   * NULL for every other pendingOperation value. Set by
   * WindowRespawnService.enforceExecutionGate alongside pendingOperation and
   * cleared whenever pendingOperation is cleared.
   */
  pendingOperationWindowId: number | null;
  /**
   * task.status immediately before the execution gate overwrote it with
   * 'pending_approval' (Issue #328 seventh-round review symptom B) — the
   * status every pendingOperation's approval handling above restores to
   * (directly for 'resume_await_answer'/'resume_await_plan_review', or after
   * a successful 'respawn'/'recover_session_legacy' run; 'execute'/'resume'/
   * 'restore' manage their own status on success and don't consult this).
   * NULL alongside pendingOperation === null (the normal state) or for any
   * row written before this column existed — none in practice, same as
   * pendingOperation/pendingOperationWindowId (059 has never shipped).
   */
  pendingOperationPriorStatus: TaskStatus | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  baseBranch: string | null;
  targetBranch: string | null;
  skipPr: boolean;
  workingDirectory: string | null;
  branch: string | null;
  planMarkdown: string | null;
  pendingQuestions: string | null;
  changedFiles: string | null;
  summaryJson: string | null;
  prUrl: string | null;
  agentSessionId: string | null;
  reviewSubagent?: SubagentConfig | null;
  implementSubagent?: SubagentConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface ITaskRepository {
  findAll(): Task[];
  findByProject(projectId: number): Task[];
  findByUnit(unitId: number): Task[];
  findByStatus(status: TaskStatus): Task[];
  findAgentSessionIdsByServer(serverName: string): Set<string>;
  findById(id: number): Task | null;
  create(data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): number;
  update(id: number, data: Partial<Task>): void;
  updateStatus(id: number, status: TaskStatus): void;
  updateCurrentPhase(id: number, phase: string | null): void;
  touch(id: number): void;
  delete(id: number): void;
  /**
   * Atomically consumes ("claims") this task's pending execution-gate
   * approval (Issue #328 ninth-round review finding 4) — the write is
   * guarded on `status = 'pending_approval' AND pending_operation IS NOT
   * NULL` in a single statement, so a duplicate/racing call for the same
   * task (POST /api/tasks/:id/approve-execution submitted twice) affects
   * zero rows on the second call instead of both callers reading the same
   * pendingOperation/pendingOperationWindowId/pendingOperationPriorStatus
   * and each independently dispatching a resume/respawn/restore.
   *
   * Always clears pendingOperation/pendingOperationWindowId/
   * pendingOperationPriorStatus on success; `fields.status` and
   * `fields.executionApprovedFingerprintHash` are applied in the same
   * statement when provided (the approve-execution handler's approve branch
   * passes the fingerprint, its deny branch passes the status — never both,
   * since approval's per-operation status transition is decided afterward
   * by the caller, not by this method).
   *
   * Returns true iff THIS call was the one that consumed it (safe to
   * proceed with the dispatch the caller already resolved `operation`/
   * `pendingOperationWindowId` for); false means another call already
   * consumed it (or the row is no longer in a consumable state) — the
   * caller must reject (409), not fall back to any other signal to guess
   * what to do.
   *
   * `executionApprovedFingerprintHash` is `string`, not `string | null`
   * (Issue #328 thirteenth-round review, fix 2): the underlying UPDATE uses
   * `COALESCE(?, execution_approved_fingerprint_hash)` per field, so an
   * omitted field leaves the column unchanged — but an explicit `null` would
   * ALSO leave it unchanged (COALESCE only short-circuits on SQL NULL, and
   * this implementation maps both "omitted" and "explicit null" to the same
   * bound `null` parameter), never clearing it. The two call sites in
   * ExecutionApprovalDecision.ts's approve-execution handler only ever pass a real hash
   * string from `hashExecutionManifest()` (the approve branch) or omit the
   * field entirely (the deny branch, which passes `status` instead) —
   * neither needs to clear an existing hash, so the type no longer offers a
   * capability ("pass null to clear") the implementation doesn't provide.
   */
  consumePendingApproval(id: number, fields: { status?: TaskStatus; executionApprovedFingerprintHash?: string }): boolean;
  /**
   * Atomically records that the untrusted-input execution gate has blocked
   * `id` pending human approval (Issue #328 review round) — the compare-and-
   * swap counterpart to {@link consumePendingApproval}, guarded the same way
   * (a single UPDATE, not a read-then-write) so a SECOND blocked entry point
   * arriving after the first can never overwrite it.
   *
   * Before this method existed, ExecuteTaskUseCase.enforceExecutionGate and
   * PhaseLoopRunner.reverifyExecutionGateForPhase each called
   * `taskRepo.update(id, { status: 'pending_approval', pendingOperation,
   * pendingOperationPriorStatus: task.status })` unconditionally. Neither
   * execute() nor follow-up() rejects a task that is ALREADY
   * `pending_approval` before calling in — so a second blocked call (e.g. a
   * follow-up request racing an execute() request for the same untrusted
   * task) would overwrite the FIRST block's `pendingOperation` with its own,
   * and — worse — read `task.status` as `'pending_approval'` (the status the
   * FIRST call had already written) and persist THAT as
   * `pendingOperationPriorStatus`, permanently losing the task's real prior
   * status (e.g. `'review'` or `'in_progress'`). On approval, the task would
   * then be restored to `'pending_approval'` instead of its actual prior
   * status.
   *
   * This write only succeeds while the task ISN'T already blocked — guarded
   * on `pending_operation IS NULL` (the same invariant
   * {@link consumePendingApproval}'s guard restores on every exit: approval,
   * denial, and this method's own success all leave pendingOperation
   * non-NULL only while a block is genuinely outstanding). A second call
   * while one is already pending is a no-op (returns false); the caller must
   * NOT re-log a `status_change` event when it does (the first block's
   * notification already reached the client) — see the call sites for how
   * `false` is handled.
   *
   * `priorStatus` must be the CALLER'S OWN task snapshot's status, exactly
   * as {@link consumePendingApproval}'s `fields.status` is caller-supplied —
   * this method does not re-read the row itself before writing, so passing a
   * stale/already-`pending_approval` status here defeats the guard's
   * purpose. Every call site derives it from the same `task` object it just
   * used to resolve the manifest (never a fresh `findById()`), matching this
   * contract.
   *
   * Returns true iff this call was the one that recorded the block (the
   * caller should log the entry-point-appropriate `status_change` event);
   * false means another block was already outstanding for this task (the
   * caller must not overwrite it, and must not log a duplicate
   * `status_change`).
   *
   * `fields.manifestHash` (Issue #328 review round, fix 2) is the SAME
   * `hashExecutionManifest(...)` value the caller just passed to
   * `checkExecutionGate()` to decide it needed to block. The guarded UPDATE
   * folds it into its WHERE clause (`execution_approved_fingerprint_hash IS
   * NULL OR execution_approved_fingerprint_hash != manifestHash`) so a block
   * that is ALREADY stale by the time it reaches the database — because a
   * concurrent approval matching this exact manifest landed first — is
   * rejected instead of writing anyway. Without this, the following race
   * rewinds an already-approved task back to `pending_approval`: (1) request
   * A evaluates the gate and decides to block; (2) request B concurrently
   * approves the SAME outstanding block, clearing `pending_operation` back to
   * NULL; (3) A's now-unguarded (by the old `pending_operation IS NULL`-only
   * condition) UPDATE succeeds, re-blocking a task a human just approved, and
   * — worse — persists A's stale `priorStatus` snapshot (captured while the
   * task was still `pending_approval` from the block B just resolved) as
   * `pendingOperationPriorStatus`, corrupting it with `pending_approval`
   * itself (a value approval could then "restore" to — a self-loop the UI
   * can never escape from without manual intervention).
   *
   * `fields.priorStatus === 'pending_approval'` is refused outright (the
   * implementation returns false without writing) as a second, independent
   * guard against that same corruption: a caller-supplied snapshot is never
   * allowed to already BE `pending_approval` — see the invariant described
   * above and in `pendingOperationPriorStatus`'s own doc comment.
   *
   * `fields.pendingOperationWindowId` extends this atomic write to cover
   * WindowRespawnService.enforceExecutionGate's `'respawn'` case (Issue #328
   * review round fix 1), which must record `pendingOperationWindowId`
   * alongside `pendingOperation` in the SAME statement — a separate follow-up
   * write would reopen the exact non-atomic read-then-write gap this method
   * exists to close. Omitted (or explicit `null`) for every other operation,
   * matching `pendingOperationWindowId`'s own doc comment.
   */
  recordExecutionGateBlock(
    id: number,
    fields: {
      pendingOperation: NonNullable<Task['pendingOperation']>;
      priorStatus: TaskStatus;
      manifestHash: string;
      pendingOperationWindowId?: number | null;
    },
  ): boolean;
}
