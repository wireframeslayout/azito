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
   * Who/what originated this task (Issue #28 design v3 §5,
   * TaskOriginationService) — set once at creation by the single
   * `TaskOriginationService.create()` every task-creation path funnels
   * through (`POST /api/tasks`, `POST /api/projects/:id/import-issue`,
   * `POST /api/tasks/:id/children`, and the future #62 trigger layer) and
   * never updated afterward. `'system'` is the catch-all for a principal
   * class with no single human/task subject (`runtime`/`agent`) — nothing
   * in this phase actually creates a task under that principal, but the
   * type exists so a future trigger/system entry point has somewhere to
   * land instead of being force-fit into `'operator'`.
   *
   * This is the ONLY input {@link deriveInputTrust} trusts to decide
   * `inputTrust` — unlike `source` (freely rewritable via /azt-link),
   * `createdByKind`/`createdById` are never accepted from a request body.
   */
  createdByKind: 'operator' | 'task' | 'trigger' | 'system';
  /** The class-specific origin id (e.g. the parent task's id for `createdByKind: 'task'`). Null for `'operator'`/`'system'`, which have no single subject. */
  createdById: number | null;
  /**
   * The creating task-token's `window_generation` at the moment `POST
   * /api/tasks/:id/children` created this row (Issue #28 third-party review
   * fix: "children count limit was lifetime, not per-run"). NULL when this
   * task wasn't created by a task principal at all (`createdByKind !==
   * 'task'`, e.g. `POST /api/tasks`/`import-issue`) OR when an OPERATOR
   * principal called `POST /api/tasks/:id/children` directly (design v3 §4
   * fixes `origin.kind` to `'task'` regardless of which principal actually
   * called it — see TaskOriginationService's doc comment — but only a task
   * principal has a token generation to stamp here).
   *
   * This is what makes the children-count rate limit reset across follow-up
   * calls instead of accumulating forever: `countChildrenInGeneration` scopes
   * the count to `createdByKind = 'task' AND createdById = parentId AND
   * createdViaGeneration = <the parent's CURRENT active generation>`, so a
   * parent whose window was regenerated (a fresh execute()/follow-up/respawn)
   * gets a fresh N=20 budget for the new run — the OLD generation's already-
   * created children remain in the table (a full audit trail) but no longer
   * count toward the limit. An operator-originated child (generation NULL)
   * is counted by the separate, looser lifetime cap instead (see
   * `countChildren`'s doc comment) since there is no generation to scope it
   * to.
   */
  createdViaGeneration: number | null;
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

/**
 * The single source of truth for how a task's origin maps to
 * `Task['inputTrust']` (Issue #28 design v3 §5, fail-safe reversal of the
 * Issue #328 original) — every task-creation and task-update code path MUST
 * derive `inputTrust` through this function rather than deciding it inline.
 *
 * Trusted requires BOTH conditions: `createdByKind === 'operator'` (a human
 * acting through the UI/CLI with a UI token, not a task/trigger/system
 * principal) AND `source === 'local'` (not an imported external issue).
 * Every other combination — `task`/`trigger`/`system` origin regardless of
 * `source`, or `operator` origin with `source` `'github'`/`'gitlab'` — is
 * `'untrusted'`. This is deliberately fail-safe in the direction that
 * matters: a new `source` value or a new principal class added later that
 * nobody updates this function for falls through to `'untrusted'`, not
 * `'trusted'` (the earlier, Issue #328 version of this function inverted
 * that: it listed the untrusted cases and defaulted everything else to
 * trusted, so a forgotten update silently widened trust instead of
 * narrowing it).
 *
 * Before Issue #328's original version of this function existed, `POST
 * /api/tasks` hardcoded `inputTrust: 'trusted'` regardless of `source`
 * while `POST /api/projects/:id/import-issue` independently hardcoded
 * `'untrusted'` — the two decisions drifted, and the browser's actual
 * GitHub-issue-import flow (which posts to `/api/tasks`, not
 * `import-issue`) went through the always-`'trusted'` path, defeating the
 * execution gate entirely for externally-sourced tasks. Issue #28's
 * TaskOriginationService (modules/tasks/origination/TaskOriginationService.ts)
 * is now the ONLY caller of this function at creation time, closing that gap
 * for good — no route decides `inputTrust` on its own anymore.
 *
 * This function is intentionally one-directional in effect only when
 * combined with the monotonicity rule enforced at each call site (never
 * transition an already-`'untrusted'` task back to `'trusted'` — see
 * `PUT /api/tasks/:id` in modules/tasks/routes.ts, which floors the
 * derived value at the task's current trust level instead of applying
 * this function's output unconditionally). This function alone is a pure
 * mapping from `createdByKind`/`source` and does not know about a task's
 * prior trust level.
 */
export function deriveInputTrust(createdByKind: Task['createdByKind'], source: Task['source']): Task['inputTrust'] {
  return createdByKind === 'operator' && source === 'local' ? 'trusted' : 'untrusted';
}

/** The only values {@link deriveInputTrust} (and thus the execution gate) understands. */
const VALID_TASK_SOURCES: readonly Task['source'][] = ['local', 'github', 'gitlab'];

/**
 * Validates the raw `source`/`source_ref` request-body fields shared by
 * POST /api/tasks and PUT /api/tasks/:id (third-party review, task/328
 * follow-up) — before this, both endpoints only cast `source` to
 * `Task['source']` without checking it against `VALID_TASK_SOURCES`, so a
 * caller-supplied `"GitHub"` (wrong case) or `"github "` (stray whitespace)
 * was stored verbatim and fell through `deriveInputTrust()`'s `===`
 * comparison to `'trusted'` — silently defeating the untrusted-origin
 * execution gate for content that looks exactly like a GitHub import.
 *
 * Also rejects `source_ref` supplied without `source` in the SAME request:
 * a task that carries a `sourceRef` (so it visibly looks issue-linked in the
 * UI) while `source` stays unset/`'local'` would derive `'trusted'` despite
 * appearing to originate from an external issue.
 *
 * Pure function (no I/O) so callers translate its `{ error }` result into
 * their own 400 response shape; returns `undefined` for a field the caller
 * didn't touch (PUT's partial-update semantics), never coerces a value.
 */
export function validateTaskSourceFields(
  source: unknown,
  sourceRef: unknown,
): { error: string } | { source: Task['source'] | undefined; sourceRef: string | null | undefined } {
  if (source !== undefined) {
    if (typeof source !== 'string' || !VALID_TASK_SOURCES.includes(source as Task['source'])) {
      return { error: `source must be one of: ${VALID_TASK_SOURCES.join(', ')}` };
    }
  }
  if (sourceRef !== undefined && sourceRef !== null) {
    if (typeof sourceRef !== 'string') {
      return { error: 'source_ref must be a string' };
    }
    if (source === undefined) {
      return { error: 'source is required when source_ref is provided' };
    }
  }
  return {
    source: source as Task['source'] | undefined,
    sourceRef: sourceRef as string | null | undefined,
  };
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
   * The guarded UPDATE additionally requires `status = fields.priorStatus`
   * (Issue #328 review round, status-CAS fix): without this, a status change
   * that lands between the caller's stale read and this write (e.g. the task
   * gets archived) would be silently clobbered back to `pending_approval` by
   * this UPDATE, letting a later approval revive/execute an already-archived
   * task. Failing this comparison returns false the same way the
   * fingerprint/pending_operation guards do — the caller must treat it as
   * "another writer changed this task" and not retry with a stale snapshot.
   *
   * `priorStatus` must be the CALLER'S OWN task snapshot's status, exactly
   * as {@link consumePendingApproval}'s `fields.status` is caller-supplied —
   * this method does not re-read the row itself before writing, so passing a
   * stale/already-`pending_approval` status here defeats the guard's
   * purpose. Every call site derives it from the same `task` object it just
   * used to resolve the manifest (never a fresh `findById()`), matching this
   * contract. It now doubles as the CAS comparison value above, so it must
   * be accurate — not just any valid TaskStatus.
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
  /**
   * Atomically records creation-time pre-approval for an untrusted-origin
   * task that has NEVER been gate-blocked (interactive create-form approval
   * — see modules/tasks/execution/ExecutionApprovalDecision.ts's
   * decideExecutionPreApproval). Writes ONLY
   * `execution_approved_fingerprint_hash`; unlike {@link consumePendingApproval}
   * this never touches `status`/`pending_operation*` — there is no blocked
   * operation to resume here, only a fingerprint to pre-record so the task's
   * FIRST later `execute` call satisfies `checkExecutionGate` immediately
   * instead of blocking.
   *
   * Guarded compare-and-swap, matching this file's existing
   * consumePendingApproval/recordExecutionGateBlock style (a single UPDATE,
   * not read-then-write): only succeeds while `status = 'open'`,
   * `pending_operation IS NULL`, and `input_trust = 'untrusted'` — a task
   * that has already been gate-blocked (pendingOperation set), has moved
   * past 'open', or isn't untrusted at all must not take this shortcut; it
   * goes through the normal pending_approval panel
   * (`decideExecutionApproval`) instead. Returns true iff this call was the
   * one that recorded it; false means the task's state changed out from
   * under the caller between resolving the manifest and writing this (the
   * caller must reject, not silently retry with a different manifest).
   */
  preApproveExecution(id: number, fingerprintHash: string): boolean;

  /**
   * Count of tasks with `createdByKind: 'task'` and `createdById:
   * parentTaskId` — LIFETIME total, across every generation and every caller
   * (task principal or operator). Backs the loose operator-path cap on `POST
   * /api/tasks/:id/children` (Issue #28 third-party review fix: an operator
   * call has no window generation to scope a per-run limit to — see
   * `createdViaGeneration`'s doc comment — so it falls back to this
   * unscoped, deliberately-looser lifetime bound rather than being
   * unlimited). Also used as a general "how many children has this task ever
   * spawned" figure wherever the per-generation number isn't the right
   * question.
   */
  countChildren(parentTaskId: number): number;
  /**
   * Count of tasks with `createdByKind: 'task'`, `createdById: parentTaskId`,
   * AND `createdViaGeneration: generation` — backs the per-run N=20 cap on
   * `POST /api/tasks/:id/children` when the caller is a task principal
   * (Issue #28 third-party review fix: the previous `countChildren` cap
   * counted the parent's ENTIRE lifetime child count, so a parent that spans
   * multiple follow-up runs could never spawn more children at all once the
   * lifetime total crossed 20, even though only the CURRENT run should be
   * bounded). `generation` is the parent's currently active
   * `task_tokens.window_generation` (see
   * `ITaskTokenRepository.getActiveGeneration`), resolved by the route at
   * request time — never the caller-supplied body, which cannot be trusted
   * to report its own generation honestly.
   */
  countChildrenInGeneration(parentTaskId: number, generation: number): number;

  /**
   * Atomically clears `tmuxWindow` — but ONLY if it still equals
   * `expectedWindowName` — and reports whether it did (Issue #28 third-party
   * review, Fix 3: rollback-race finding). `ExecuteTaskUseCase.execute()`/
   * `followUp()` create a new tmux window generation under
   * `runExclusiveForTask` (see WindowRotation.ts), but everything downstream
   * of that (worktree creation and ITS OWN failure rollback) runs OUTSIDE
   * the lock — deliberately, since worktree creation can be a slow
   * network/SSH round trip and holding the in-memory per-task lock that long
   * would serialize unrelated work for no benefit. That gap means a second,
   * concurrent `execute()`/`followUp()` call for the SAME task (e.g. a UI
   * respawn racing a follow-up) can acquire the lock, create ITS OWN newer
   * window generation, and persist ITS `tmuxWindow` — all while the FIRST
   * call's worktree step is still failing and about to roll back. A plain
   * `update(id, { tmuxWindow: null })` at that point would blindly null out
   * the newer generation's window reference (whichever one happens to be in
   * the row right now), untracking a live pane and its token. This method's
   * WHERE-guarded UPDATE makes the rollback a no-op instead whenever the row
   * has already moved on to a different window — the caller's own rollback
   * (kill + token revoke, scoped to the tokenId IT issued) still runs
   * unconditionally, since that part only ever affects the generation this
   * specific call created.
   */
  clearTmuxWindowIfMatches(id: number, expectedWindowName: string): boolean;
}
