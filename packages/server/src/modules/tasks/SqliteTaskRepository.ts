import type { SqliteDatabase } from '../../shared/db/Database';
import type { Task, ITaskRepository } from './Task';
import type { TaskStatus } from './TaskStatus';
import type { SubagentConfig } from '../units/Unit';
import type { ITaskTokenRepository } from './tokens/TaskToken';

/**
 * Statuses that must revoke every outstanding task_tokens row for the task
 * (Issue #28 design v3 §2: "失効はリポジトリの状態遷移 API 1箇所に集約").
 * Enforced by {@link SqliteTaskRepository.revokeIfTokenRevokingStatus}, the single
 * internal helper every status-writing method (updateStatus(), update(),
 * consumePendingApproval()) routes through in the same transaction as its
 * status write — every one of the ~25 scattered
 * `taskRepo.updateStatus(...)`/`taskRepo.update(..., { status })` call sites
 * across PhaseLoopRunner/ExecuteTaskUseCase/RecoverStuckTasksUseCase/units
 * routes benefits automatically, and none of them needs to know task_tokens
 * exists. (recordExecutionGateBlock()/preApproveExecution() never write a
 * terminal status — see their own doc comments on ITaskRepository — so they
 * do not need this helper.)
 *
 * NOT the same set as "terminal status" (renamed from
 * TERMINAL_TASK_STATUSES — Issue #28 third-party review finding 1): `review`
 * and `failed` are both statuses a human can resume from via
 * `ExecuteTaskUseCase.followUp()` (units routes' `/api/units/:id/follow-up`,
 * also reachable through the answer-submit and plan-feedback flows), which
 * — when the task's tmux window is still alive, the common case for both —
 * resumes onto that SAME window without minting a new token (design v3 §2:
 * "resume onto an existing window never rotates"). Revoking on a status the
 * task can still be resumed from would hand that resumed pane a dead token
 * and 401 every authorized call it makes.
 *   - `review`: the success terminal of a normal run. Follow-up on a
 *     `review` task is the PRIMARY way a human continues it (feedback,
 *     more work) — this is not an edge case.
 *   - `failed`: also follow-up-resumable in practice. The purpose-built
 *     `POST /api/tasks/:id/retry` path explicitly clears `tmuxWindow` before
 *     resetting to `open`, so it always gets a fresh window + token and
 *     never depends on this set either way — but most `failed` transitions
 *     in ExecuteTaskUseCase/PhaseLoopRunner do NOT clear `tmuxWindow`, and
 *     the frontend's follow-up comment box is enabled for `failed` exactly
 *     like it is for `review` (`TaskLogView.tsx`'s `canComment` excludes
 *     only `in_progress`/`open`). So a `failed` task with a live window hits
 *     the identical resume-onto-existing-window path as `review` and must
 *     be excluded for the same reason.
 *   - `done`/`archived`: neither is resumed onto a live window. `done` is
 *     not reachable through the normal completion flow at all (that always
 *     lands on `review` — see PhaseLoopRunner.finalize()); `archived` always
 *     clears `tmuxWindow` in the same write that sets the status (tasks
 *     routes' archive handler). Revoking here can never break a resume.
 *
 * A revoked token's authority is narrow (a handful of read-only,
 * own-task-scoped routes — see routeAuth.ts), so keeping it alive through
 * `review`/`failed` is not a meaningful risk increase; it is fully retired
 * the moment the task reaches a true terminal state (`done`/`archived`) or
 * is deleted.
 */
const TOKEN_REVOKING_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'archived']);

interface TaskRow {
  id: number;
  project_id: number;
  unit_id: number | null;
  server_name: string | null;
  title: string;
  description: string | null;
  status: string;
  current_phase: string | null;
  self_review_count: number;
  priority: number;
  tmux_window: string | null;
  self_review_max_attempts: number | null;
  require_plan_approval: number;
  source: string;
  source_ref: string | null;
  input_trust: string;
  execution_approved_fingerprint_hash: string | null;
  pending_operation: string | null;
  pending_operation_window_id: number | null;
  pending_operation_prior_status: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  base_branch: string | null;
  target_branch: string | null;
  skip_pr: number;
  working_directory: string | null;
  branch: string | null;
  plan_markdown: string | null;
  pending_questions: string | null;
  changed_files: string | null;
  summary_json: string | null;
  pr_url: string | null;
  agent_session_id: string | null;
  review_subagent: string | null;
  implement_subagent: string | null;
  sleep_after_push: number | null;
  distribution_repository_id: number | null;
  created_by_kind: string;
  created_by_id: number | null;
  created_via_generation: number | null;
  created_at: string;
  updated_at: string;
}

function parseSubagentConfig(raw: unknown): SubagentConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new Error(`Invalid subagent config: expected string, got ${typeof raw}`);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid subagent config: expected object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['enabled'] !== 'boolean') throw new Error('Invalid subagent config: enabled must be boolean');
  if (typeof obj['provider'] !== 'string') throw new Error('Invalid subagent config: provider must be string');
  if (typeof obj['model'] !== 'string') throw new Error('Invalid subagent config: model must be string');
  return { enabled: obj['enabled'], provider: obj['provider'], model: obj['model'] };
}

export class SqliteTaskRepository implements ITaskRepository {
  private listStmt;
  private listByProjectStmt;
  private listByUnitStmt;
  private listByStatusStmt;
  private getStmt;
  private createStmt;
  private updateStmt;
  private consumePendingApprovalStmt;
  private recordExecutionGateBlockStmt;
  private preApproveExecutionStmt;
  private updateStatusStmt;
  private updateCurrentPhaseStmt;
  private touchStmt;
  private deleteStmt;
  private findAgentSessionIdsByServerStmt;
  private countChildrenStmt;
  private countChildrenInGenerationStmt;
  private clearTmuxWindowIfMatchesStmt;
  private updateStatusIfWindowMatchesStmt;
  private updateStatusIfWindowMatchesWithWorktreeStmt;
  constructor(private db: SqliteDatabase, private taskTokenRepo: ITaskTokenRepository) {
    this.listStmt = db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at DESC');
    this.listByProjectStmt = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at DESC');
    this.listByUnitStmt = db.prepare('SELECT * FROM tasks WHERE unit_id = ? ORDER BY priority DESC, created_at DESC');
    this.listByStatusStmt = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC');
    this.getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    this.createStmt = db.prepare(
      'INSERT INTO tasks (project_id, unit_id, server_name, title, description, priority, tmux_window, self_review_max_attempts, require_plan_approval, source, source_ref, worktree_path, worktree_branch, base_branch, target_branch, skip_pr, working_directory, branch, plan_markdown, pending_questions, changed_files, summary_json, pr_url, agent_session_id, review_subagent, implement_subagent, sleep_after_push, input_trust, execution_approved_fingerprint_hash, pending_operation, pending_operation_window_id, pending_operation_prior_status, created_by_kind, created_by_id, created_via_generation, distribution_repository_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.updateStmt = db.prepare(
      "UPDATE tasks SET title = ?, description = ?, status = ?, unit_id = ?, server_name = ?, priority = ?, tmux_window = ?, self_review_max_attempts = ?, require_plan_approval = ?, source = ?, source_ref = ?, worktree_path = ?, worktree_branch = ?, base_branch = ?, target_branch = ?, skip_pr = ?, working_directory = ?, branch = ?, plan_markdown = ?, pending_questions = ?, changed_files = ?, summary_json = ?, pr_url = ?, agent_session_id = ?, review_subagent = ?, implement_subagent = ?, sleep_after_push = ?, input_trust = ?, execution_approved_fingerprint_hash = ?, pending_operation = ?, pending_operation_window_id = ?, pending_operation_prior_status = ?, distribution_repository_id = ?, updated_at = datetime('now') WHERE id = ?",
    );
    // Guarded compare-and-clear for consumePendingApproval() (Issue #328
    // ninth-round review finding 4) — see that method's doc comment on
    // ITaskRepository. COALESCE(?, column) means a NULL param leaves the
    // column unchanged, so one statement serves both the approve branch
    // (passes executionApprovedFingerprintHash, leaves status alone) and the
    // deny branch (passes status, leaves the fingerprint alone) of
    // tasks/execution/ExecutionApprovalDecision.ts's approve-execution handler.
    this.consumePendingApprovalStmt = db.prepare(
      "UPDATE tasks SET status = COALESCE(?, status), execution_approved_fingerprint_hash = COALESCE(?, execution_approved_fingerprint_hash), pending_operation = NULL, pending_operation_window_id = NULL, pending_operation_prior_status = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'pending_approval' AND pending_operation IS NOT NULL",
    );
    // Guarded compare-and-swap for recordExecutionGateBlock() (Issue #328
    // review round) — mirrors consumePendingApprovalStmt's guard style. Only
    // succeeds while no block is already outstanding (pending_operation IS
    // NULL) AND the approved fingerprint still differs from the manifest
    // hash the caller used to decide it needed to block (the second half of
    // the WHERE clause) — a concurrent approval that already matches this
    // exact manifest must not be rewound back to pending_approval. AND the
    // current status still matches the caller's stale-read snapshot
    // (fields.priorStatus) — without this, a concurrent status change (e.g.
    // archive) between the caller's read and this write would be silently
    // overwritten back to 'pending_approval', letting an already-archived
    // task be revived via later approval. See recordExecutionGateBlock's own
    // doc comment on ITaskRepository for the race this closes.
    this.recordExecutionGateBlockStmt = db.prepare(
      "UPDATE tasks SET status = 'pending_approval', pending_operation = ?, pending_operation_window_id = ?, pending_operation_prior_status = ?, updated_at = datetime('now') WHERE id = ? AND status = ? AND pending_operation IS NULL AND (execution_approved_fingerprint_hash IS NULL OR execution_approved_fingerprint_hash != ?)",
    );
    // Guarded compare-and-swap for preApproveExecution() (creation-time
    // pre-approval) — see that method's doc comment on ITaskRepository.
    // Deliberately narrower than consumePendingApprovalStmt above: it only
    // ever writes execution_approved_fingerprint_hash, never status/
    // pending_operation*, and only while the task is still in the untouched
    // 'open, never gate-blocked, untrusted' state this shortcut is for.
    this.preApproveExecutionStmt = db.prepare(
      "UPDATE tasks SET execution_approved_fingerprint_hash = ?, updated_at = datetime('now') WHERE id = ? AND status = 'open' AND pending_operation IS NULL AND input_trust = 'untrusted'",
    );
    this.updateStatusStmt = db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?");
    this.updateCurrentPhaseStmt = db.prepare("UPDATE tasks SET current_phase = ?, updated_at = datetime('now') WHERE id = ?");
    this.touchStmt = db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?");
    this.deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');
    this.findAgentSessionIdsByServerStmt = db.prepare(
      'SELECT DISTINCT agent_session_id FROM tasks WHERE server_name = ? AND agent_session_id IS NOT NULL',
    );
    this.countChildrenStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE created_by_kind = 'task' AND created_by_id = ?",
    );
    this.countChildrenInGenerationStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE created_by_kind = 'task' AND created_by_id = ? AND created_via_generation = ?",
    );
    // Guarded compare-and-clear for clearTmuxWindowIfMatches() — see that
    // method's doc comment on ITaskRepository (Issue #28 third-party review,
    // Fix 3). Only clears when the row's current tmux_window still equals
    // the caller's own generation's window name; a concurrent rotation that
    // already replaced it with a newer window leaves this a no-op.
    this.clearTmuxWindowIfMatchesStmt = db.prepare(
      "UPDATE tasks SET tmux_window = NULL, updated_at = datetime('now') WHERE id = ? AND tmux_window = ?",
    );
    // Guarded compare-and-swap for updateStatusIfWindowMatches() — see that
    // method's doc comment on ITaskRepository (Issue #87 third-party review,
    // Important 1; fourth pass). `tmux_window = ? OR tmux_window IS NULL`
    // covers the two shapes the row can be in when the caller's generation
    // is still the latest: its own window name still on the row, or no
    // window recorded yet (before this generation's own window was
    // created). Both arms are ALSO gated by the same "no newer generation"
    // NOT EXISTS check — the third review pass only applied that gate to
    // the NULL arm, which left a gap: if a newer execution has already
    // issued its own token (and thus its own, different, tmux_window) but
    // has not yet actually created that window, the row still carries the
    // OLD `tmux_window` value, so the `tmux_window = ?` arm alone would
    // match a stale caller and let it roll the task back mid-handoff. The
    // gate correlates against `task_tokens`, matching only when no OTHER
    // row for this task_id has a `window_generation` strictly greater than
    // the caller's own token's (`?` = tokenId). That is a single UPDATE
    // with a correlated NOT EXISTS subquery (no read-then-write) so the
    // check and the write stay atomic under WAL/SQLite's single-writer
    // model.
    this.updateStatusIfWindowMatchesStmt = db.prepare(`
      UPDATE tasks SET status = ?, updated_at = datetime('now')
      WHERE id = ?
        AND (tmux_window = ? OR tmux_window IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM task_tokens nt
          WHERE nt.task_id = tasks.id
            AND nt.window_generation > (SELECT window_generation FROM task_tokens WHERE id = ?)
        )
    `);
    // Same guard as updateStatusIfWindowMatchesStmt above, extended to also
    // clear worktree_path/worktree_branch in the SAME statement (Issue #87
    // third-party review, seventh pass, Important finding 2) — a stale
    // rollback that fails the guard must not clear these fields either, and
    // a second unconditional `update()` call after the guarded status write
    // could not express that.
    this.updateStatusIfWindowMatchesWithWorktreeStmt = db.prepare(`
      UPDATE tasks SET status = ?, worktree_path = ?, worktree_branch = ?, updated_at = datetime('now')
      WHERE id = ?
        AND (tmux_window = ? OR tmux_window IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM task_tokens nt
          WHERE nt.task_id = tasks.id
            AND nt.window_generation > (SELECT window_generation FROM task_tokens WHERE id = ?)
        )
    `);
  }

  findAll(): Task[] {
    return (this.listStmt.all() as TaskRow[]).map((r) => this.toEntity(r));
  }

  findByProject(projectId: number): Task[] {
    return (this.listByProjectStmt.all(projectId) as TaskRow[]).map((r) => this.toEntity(r));
  }

  findByUnit(unitId: number): Task[] {
    return (this.listByUnitStmt.all(unitId) as TaskRow[]).map((r) => this.toEntity(r));
  }

  findByStatus(status: TaskStatus): Task[] {
    return (this.listByStatusStmt.all(status) as TaskRow[]).map((r) => this.toEntity(r));
  }

  findAgentSessionIdsByServer(serverName: string): Set<string> {
    const rows = this.findAgentSessionIdsByServerStmt.all(serverName) as { agent_session_id: string }[];
    return new Set(rows.map((r) => r.agent_session_id));
  }

  findById(id: number): Task | null {
    const row = this.getStmt.get(id) as TaskRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  create(data: Omit<Task, 'id' | 'createdAt' | 'updatedAt'>): number {
    const result = this.createStmt.run(
      data.projectId,
      data.unitId,
      data.serverName ?? null,
      data.title,
      data.description ?? null,
      data.priority ?? 0,
      data.tmuxWindow ?? null,
      data.selfReviewMaxAttempts ?? null,
      data.requirePlanApproval !== false ? 1 : 0,
      data.source ?? 'local',
      data.sourceRef ?? null,
      data.worktreePath ?? null,
      data.worktreeBranch ?? null,
      data.baseBranch ?? null,
      data.targetBranch ?? null,
      data.skipPr ? 1 : 0,
      data.workingDirectory ?? null,
      data.branch ?? null,
      data.planMarkdown ?? null,
      data.pendingQuestions ?? null,
      data.changedFiles ?? null,
      data.summaryJson ?? null,
      data.prUrl ?? null,
      data.agentSessionId ?? null,
      data.reviewSubagent !== undefined ? (data.reviewSubagent !== null ? JSON.stringify(data.reviewSubagent) : null) : null,
      data.implementSubagent !== undefined ? (data.implementSubagent !== null ? JSON.stringify(data.implementSubagent) : null) : null,
      data.sleepAfterPush != null ? (data.sleepAfterPush ? 1 : 0) : null,
      data.inputTrust ?? 'trusted',
      data.executionApprovedFingerprintHash ?? null,
      data.pendingOperation ?? null,
      data.pendingOperationWindowId ?? null,
      data.pendingOperationPriorStatus ?? null,
      data.createdByKind,
      data.createdById ?? null,
      data.createdViaGeneration ?? null,
      data.distributionRepositoryId ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  update(id: number, data: Partial<Task>): void {
    const current = this.getStmt.get(id) as TaskRow | undefined;
    if (!current) return;
    const run = this.db.transaction(() => {
      this.runUpdateStmt(id, data, current);
      // Only an explicit status write can move the task into a terminal
      // status here — a write that leaves status untouched can't newly
      // terminate it, and revoking on every unrelated field write (e.g. a
      // plain agentSessionId update) would just be dead work.
      if (data.status !== undefined) this.revokeIfTokenRevokingStatus(id, data.status);
    });
    run();
  }

  private runUpdateStmt(id: number, data: Partial<Task>, current: TaskRow): void {
    this.updateStmt.run(
      data.title ?? current.title,
      data.description ?? current.description,
      data.status ?? current.status,
      data.unitId !== undefined ? data.unitId : current.unit_id,
      data.serverName !== undefined ? data.serverName : current.server_name,
      data.priority ?? current.priority,
      data.tmuxWindow ?? current.tmux_window,
      data.selfReviewMaxAttempts !== undefined ? data.selfReviewMaxAttempts : current.self_review_max_attempts,
      data.requirePlanApproval !== undefined ? (data.requirePlanApproval ? 1 : 0) : current.require_plan_approval,
      data.source !== undefined ? data.source : current.source,
      data.sourceRef !== undefined ? data.sourceRef : current.source_ref,
      data.worktreePath !== undefined ? data.worktreePath : current.worktree_path,
      data.worktreeBranch !== undefined ? data.worktreeBranch : current.worktree_branch,
      data.baseBranch !== undefined ? data.baseBranch : current.base_branch,
      data.targetBranch !== undefined ? data.targetBranch : current.target_branch,
      data.skipPr !== undefined ? (data.skipPr ? 1 : 0) : current.skip_pr,
      data.workingDirectory !== undefined ? data.workingDirectory : current.working_directory,
      data.branch !== undefined ? data.branch : current.branch,
      data.planMarkdown !== undefined ? data.planMarkdown : current.plan_markdown,
      data.pendingQuestions !== undefined ? data.pendingQuestions : current.pending_questions,
      data.changedFiles !== undefined ? data.changedFiles : current.changed_files,
      data.summaryJson !== undefined ? data.summaryJson : current.summary_json,
      data.prUrl !== undefined ? data.prUrl : current.pr_url,
      data.agentSessionId !== undefined ? data.agentSessionId : current.agent_session_id,
      data.reviewSubagent !== undefined ? (data.reviewSubagent !== null ? JSON.stringify(data.reviewSubagent) : null) : current.review_subagent,
      data.implementSubagent !== undefined ? (data.implementSubagent !== null ? JSON.stringify(data.implementSubagent) : null) : current.implement_subagent,
      data.sleepAfterPush !== undefined ? (data.sleepAfterPush != null ? (data.sleepAfterPush ? 1 : 0) : null) : current.sleep_after_push,
      data.inputTrust !== undefined ? data.inputTrust : current.input_trust,
      data.executionApprovedFingerprintHash !== undefined ? data.executionApprovedFingerprintHash : current.execution_approved_fingerprint_hash,
      data.pendingOperation !== undefined ? data.pendingOperation : current.pending_operation,
      data.pendingOperationWindowId !== undefined ? data.pendingOperationWindowId : current.pending_operation_window_id,
      data.pendingOperationPriorStatus !== undefined ? data.pendingOperationPriorStatus : current.pending_operation_prior_status,
      data.distributionRepositoryId !== undefined ? data.distributionRepositoryId : current.distribution_repository_id,
      id,
    );
  }

  consumePendingApproval(id: number, fields: { status?: TaskStatus; executionApprovedFingerprintHash?: string }): boolean {
    const run = this.db.transaction(() => {
      const result = this.consumePendingApprovalStmt.run(fields.status ?? null, fields.executionApprovedFingerprintHash ?? null, id);
      // A deny decision can land the task on 'failed'/'archived' (see
      // ExecutionApprovalDecision.ts's denyStatus) in this same guarded
      // UPDATE, never through updateStatus(). Route it through the same
      // revocation helper regardless — only 'archived' actually revokes
      // (see the doc comment on TOKEN_REVOKING_STATUSES above), but every
      // status-writing path must go through this chokepoint so none of them
      // has to know which statuses revoke.
      if (result.changes > 0 && fields.status !== undefined) this.revokeIfTokenRevokingStatus(id, fields.status);
      return result.changes > 0;
    });
    return run();
  }

  recordExecutionGateBlock(
    id: number,
    fields: {
      pendingOperation: NonNullable<Task['pendingOperation']>;
      priorStatus: TaskStatus;
      manifestHash: string;
      pendingOperationWindowId?: number | null;
    },
  ): boolean {
    // A caller-supplied snapshot must never already be 'pending_approval' —
    // see the doc comment on ITaskRepository.recordExecutionGateBlock. This
    // is a defensive guard independent of the fingerprint check above: it
    // refuses to persist a self-referential prior status even in the (rarer)
    // case where the manifest itself changed between the stale read and the
    // concurrent approval, which the fingerprint condition alone would not
    // catch.
    if (fields.priorStatus === ('pending_approval' as TaskStatus)) return false;
    const result = this.recordExecutionGateBlockStmt.run(
      fields.pendingOperation,
      fields.pendingOperationWindowId ?? null,
      fields.priorStatus,
      id,
      fields.priorStatus,
      fields.manifestHash,
    );
    return result.changes > 0;
  }

  preApproveExecution(id: number, fingerprintHash: string): boolean {
    const result = this.preApproveExecutionStmt.run(fingerprintHash, id);
    return result.changes > 0;
  }

  updateStatus(id: number, status: TaskStatus): void {
    const run = this.db.transaction(() => {
      this.updateStatusStmt.run(status, id);
      this.revokeIfTokenRevokingStatus(id, status);
    });
    run();
  }

  /**
   * Single internal chokepoint for token revocation on a status write — see
   * the doc comment on TOKEN_REVOKING_STATUSES above. Callers MUST invoke
   * this inside the same `this.db.transaction(...)` as the status-writing
   * UPDATE it follows, so a crash between the two can never leave a
   * revoking status with live tokens.
   */
  private revokeIfTokenRevokingStatus(id: number, status: TaskStatus): void {
    if (TOKEN_REVOKING_STATUSES.has(status)) {
      this.taskTokenRepo.revokeAllForTask(id, `task_status:${status}`);
    }
  }

  updateCurrentPhase(id: number, phase: string | null): void {
    this.updateCurrentPhaseStmt.run(phase, id);
  }

  touch(id: number): void {
    this.touchStmt.run(id);
  }

  delete(id: number): void {
    // Deletion revokes (not cascades) outstanding task tokens in the same
    // transaction — see the doc comment on ITaskTokenRepository.revokeAllForTask.
    const run = this.db.transaction(() => {
      this.taskTokenRepo.revokeAllForTask(id, 'task_deleted');
      this.deleteStmt.run(id);
    });
    run();
  }

  countChildren(parentTaskId: number): number {
    const row = this.countChildrenStmt.get(parentTaskId) as { n: number };
    return row.n;
  }

  countChildrenInGeneration(parentTaskId: number, generation: number): number {
    const row = this.countChildrenInGenerationStmt.get(parentTaskId, generation) as { n: number };
    return row.n;
  }

  clearTmuxWindowIfMatches(id: number, expectedWindowName: string): boolean {
    const result = this.clearTmuxWindowIfMatchesStmt.run(id, expectedWindowName);
    return result.changes > 0;
  }

  updateStatusIfWindowMatches(
    id: number,
    expectedWindowName: string,
    status: TaskStatus,
    tokenId: number,
    extraFields?: { worktreePath: string | null; worktreeBranch: string | null },
  ): boolean {
    const run = this.db.transaction(() => {
      const result = extraFields
        ? this.updateStatusIfWindowMatchesWithWorktreeStmt.run(
            status,
            extraFields.worktreePath,
            extraFields.worktreeBranch,
            id,
            expectedWindowName,
            tokenId,
          )
        : this.updateStatusIfWindowMatchesStmt.run(status, id, expectedWindowName, tokenId);
      if (result.changes > 0) this.revokeIfTokenRevokingStatus(id, status);
      return result.changes > 0;
    });
    return run();
  }

  private toEntity(row: TaskRow): Task {
    return {
      id: row.id,
      projectId: row.project_id,
      unitId: row.unit_id ?? null,
      serverName: row.server_name ?? null,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      currentPhase: row.current_phase ?? null,
      selfReviewCount: row.self_review_count ?? 0,
      priority: row.priority,
      tmuxWindow: row.tmux_window,
      selfReviewMaxAttempts: row.self_review_max_attempts ?? null,
      requirePlanApproval: row.require_plan_approval !== 0,
      source: row.source as 'local' | 'github' | 'gitlab',
      sourceRef: row.source_ref,
      worktreePath: row.worktree_path ?? null,
      worktreeBranch: row.worktree_branch ?? null,
      baseBranch: row.base_branch ?? null,
      targetBranch: row.target_branch ?? null,
      skipPr: !!row.skip_pr,
      workingDirectory: row.working_directory ?? null,
      branch: row.branch ?? null,
      planMarkdown: row.plan_markdown ?? null,
      pendingQuestions: row.pending_questions ?? null,
      changedFiles: row.changed_files ?? null,
      summaryJson: row.summary_json ?? null,
      prUrl: row.pr_url ?? null,
      agentSessionId: row.agent_session_id ?? null,
      reviewSubagent: parseSubagentConfig(row.review_subagent),
      implementSubagent: parseSubagentConfig(row.implement_subagent),
      sleepAfterPush: row.sleep_after_push != null ? row.sleep_after_push === 1 : null,
      inputTrust: row.input_trust as 'trusted' | 'untrusted',
      executionApprovedFingerprintHash: row.execution_approved_fingerprint_hash ?? null,
      pendingOperation: (row.pending_operation ?? null) as
        | 'execute'
        | 'resume'
        | 'resume_await_answer'
        | 'resume_await_plan_review'
        | 'restore'
        | 'respawn'
        | 'recover_session_legacy'
        | null,
      pendingOperationWindowId: row.pending_operation_window_id ?? null,
      pendingOperationPriorStatus: (row.pending_operation_prior_status ?? null) as TaskStatus | null,
      distributionRepositoryId: row.distribution_repository_id ?? null,
      createdByKind: row.created_by_kind as Task['createdByKind'],
      createdById: row.created_by_id ?? null,
      createdViaGeneration: row.created_via_generation ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
