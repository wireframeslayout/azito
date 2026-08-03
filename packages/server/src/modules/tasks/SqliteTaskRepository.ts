import type { SqliteDatabase } from '../../shared/db/Database';
import type { Task, ITaskRepository } from './Task';
import type { TaskStatus } from './TaskStatus';
import type { SubagentConfig } from '../units/Unit';

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
  private updateStatusStmt;
  private updateCurrentPhaseStmt;
  private touchStmt;
  private deleteStmt;
  private findAgentSessionIdsByServerStmt;
  constructor(private db: SqliteDatabase) {
    this.listStmt = db.prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at DESC');
    this.listByProjectStmt = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at DESC');
    this.listByUnitStmt = db.prepare('SELECT * FROM tasks WHERE unit_id = ? ORDER BY priority DESC, created_at DESC');
    this.listByStatusStmt = db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC');
    this.getStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    this.createStmt = db.prepare(
      'INSERT INTO tasks (project_id, unit_id, server_name, title, description, priority, tmux_window, self_review_max_attempts, require_plan_approval, source, source_ref, worktree_path, worktree_branch, base_branch, target_branch, skip_pr, working_directory, branch, plan_markdown, pending_questions, changed_files, summary_json, pr_url, agent_session_id, review_subagent, implement_subagent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.updateStmt = db.prepare(
      "UPDATE tasks SET title = ?, description = ?, status = ?, unit_id = ?, server_name = ?, priority = ?, tmux_window = ?, self_review_max_attempts = ?, require_plan_approval = ?, source = ?, source_ref = ?, worktree_path = ?, worktree_branch = ?, base_branch = ?, target_branch = ?, skip_pr = ?, working_directory = ?, branch = ?, plan_markdown = ?, pending_questions = ?, changed_files = ?, summary_json = ?, pr_url = ?, agent_session_id = ?, review_subagent = ?, implement_subagent = ?, updated_at = datetime('now') WHERE id = ?",
    );
    this.updateStatusStmt = db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?");
    this.updateCurrentPhaseStmt = db.prepare("UPDATE tasks SET current_phase = ?, updated_at = datetime('now') WHERE id = ?");
    this.touchStmt = db.prepare("UPDATE tasks SET updated_at = datetime('now') WHERE id = ?");
    this.deleteStmt = db.prepare('DELETE FROM tasks WHERE id = ?');
    this.findAgentSessionIdsByServerStmt = db.prepare(
      'SELECT DISTINCT agent_session_id FROM tasks WHERE server_name = ? AND agent_session_id IS NOT NULL',
    );
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
    );
    return Number(result.lastInsertRowid);
  }

  update(id: number, data: Partial<Task>): void {
    const current = this.getStmt.get(id) as TaskRow | undefined;
    if (!current) return;
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
      id,
    );
  }

  updateStatus(id: number, status: TaskStatus): void {
    this.updateStatusStmt.run(status, id);
  }

  updateCurrentPhase(id: number, phase: string | null): void {
    this.updateCurrentPhaseStmt.run(phase, id);
  }

  touch(id: number): void {
    this.touchStmt.run(id);
  }

  delete(id: number): void {
    this.deleteStmt.run(id);
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
