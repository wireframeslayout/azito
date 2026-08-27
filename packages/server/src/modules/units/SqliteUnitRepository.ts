import type { SqliteDatabase } from '../../shared/db/Database';
import type { Unit, IUnitRepository, SubagentConfig, WorkerExecutionMode, WorkerRuntime } from './Unit';
import type { PhaseConfig } from '../sidekicks/PhaseConfig';

interface UnitRow {
  id: number;
  name: string;
  unit_type: string;
  system_prompt: string | null;
  self_review_max_attempts: number;
  review_subagent: string | null;
  implement_subagent: string | null;
  phase_config: string | null;
  worker_type: string | null;
  worker_model: string | null;
  worker_extra_args: string | null;
  worker_execution_mode: string;
  worker_runtime: string;
  sleep_after_push: number;
  created_at: string;
  updated_at: string;
}

function parsePhaseConfig(raw: unknown): PhaseConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new Error(`Invalid phase_config: expected string, got ${typeof raw}`);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Invalid phase_config: expected object');
  }
  return parsed as PhaseConfig;
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

export class SqliteUnitRepository implements IUnitRepository {
  private listStmt;
  private getStmt;
  private createStmt;
  private updateStmt;
  private deleteStmt;

  constructor(private db: SqliteDatabase) {
    this.listStmt = db.prepare('SELECT * FROM units ORDER BY created_at DESC');
    this.getStmt = db.prepare('SELECT * FROM units WHERE id = ?');
    this.createStmt = db.prepare(
      `INSERT INTO units (name, unit_type, system_prompt, self_review_max_attempts, review_subagent, implement_subagent, phase_config, worker_type, worker_model, worker_extra_args, worker_execution_mode, worker_runtime, sleep_after_push) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateStmt = db.prepare(
      `UPDATE units SET name = ?, unit_type = ?, system_prompt = ?, self_review_max_attempts = ?, review_subagent = ?, implement_subagent = ?, phase_config = ?, worker_type = ?, worker_model = ?, worker_extra_args = ?, worker_execution_mode = ?, worker_runtime = ?, sleep_after_push = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    this.deleteStmt = db.prepare('DELETE FROM units WHERE id = ?');
  }

  findAll(): Unit[] {
    const rows = this.listStmt.all() as UnitRow[];
    return rows.map((r) => this.toDetail(r));
  }

  findById(id: number): Unit | null {
    const row = this.getStmt.get(id) as UnitRow | undefined;
    return row ? this.toDetail(row) : null;
  }

  create(data: Omit<Unit, 'id' | 'createdAt' | 'updatedAt'>): number {
    const result = this.createStmt.run(
      data.name,
      data.unitType ?? 'devops',
      data.systemPrompt ?? null,
      data.selfReviewMaxAttempts ?? 2,
      data.reviewSubagent !== undefined ? JSON.stringify(data.reviewSubagent) : null,
      data.implementSubagent !== undefined ? JSON.stringify(data.implementSubagent) : null,
      data.phaseConfig !== undefined && data.phaseConfig !== null ? JSON.stringify(data.phaseConfig) : null,
      data.workerType ?? null,
      data.workerModel ?? null,
      data.workerExtraArgs ?? null,
      data.workerExecutionMode ?? 'tmux-pipe',
      data.workerRuntime ?? 'tui',
      data.sleepAfterPush ? 1 : 0,
    );
    return Number(result.lastInsertRowid);
  }

  update(id: number, data: Partial<Unit>): void {
    const current = this.getStmt.get(id) as UnitRow | undefined;
    if (!current) return;
    this.updateStmt.run(
      data.name ?? current.name,
      data.unitType ?? current.unit_type,
      data.systemPrompt !== undefined ? data.systemPrompt : current.system_prompt,
      data.selfReviewMaxAttempts ?? current.self_review_max_attempts,
      data.reviewSubagent !== undefined ? (data.reviewSubagent !== null ? JSON.stringify(data.reviewSubagent) : null) : current.review_subagent,
      data.implementSubagent !== undefined ? (data.implementSubagent !== null ? JSON.stringify(data.implementSubagent) : null) : current.implement_subagent,
      data.phaseConfig !== undefined ? (data.phaseConfig !== null ? JSON.stringify(data.phaseConfig) : null) : current.phase_config,
      data.workerType !== undefined ? data.workerType : current.worker_type,
      data.workerModel !== undefined ? data.workerModel : current.worker_model,
      data.workerExtraArgs !== undefined ? data.workerExtraArgs : current.worker_extra_args,
      data.workerExecutionMode ?? current.worker_execution_mode,
      data.workerRuntime ?? current.worker_runtime,
      data.sleepAfterPush !== undefined ? (data.sleepAfterPush ? 1 : 0) : current.sleep_after_push,
      id,
    );
  }

  delete(id: number): void {
    this.deleteStmt.run(id);
  }

  private toDetail(row: UnitRow): Unit {
    return {
      id: row.id,
      name: row.name,
      unitType: row.unit_type ?? 'devops',
      systemPrompt: row.system_prompt,
      selfReviewMaxAttempts: row.self_review_max_attempts ?? 2,
      reviewSubagent: parseSubagentConfig(row.review_subagent),
      implementSubagent: parseSubagentConfig(row.implement_subagent),
      phaseConfig: parsePhaseConfig(row.phase_config),
      workerType: row.worker_type,
      workerModel: row.worker_model,
      workerExtraArgs: row.worker_extra_args,
      workerExecutionMode: (row.worker_execution_mode || 'tmux-pipe') as WorkerExecutionMode,
      workerRuntime: (row.worker_runtime || 'tui') as WorkerRuntime,
      sleepAfterPush: row.sleep_after_push === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
