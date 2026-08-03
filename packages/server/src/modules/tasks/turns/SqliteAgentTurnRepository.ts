import type { SqliteDatabase } from '../../../shared/db/Database';
import type {
  AgentTurn,
  AgentTurnCompletionSource,
  AgentTurnConfidence,
  AgentTurnEvent,
  AgentTurnKind,
  AgentTurnStatus,
} from './AgentTurn';

const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;

interface AgentTurnRow {
  id: number;
  task_id: number;
  unit_id: number | null;
  kind: string;
  phase: string | null;
  nonce: string;
  status: string;
  completion_source: string | null;
  confidence: string | null;
  server_name: string | null;
  tmux_target: string | null;
  output_file_path: string | null;
  started_at: string;
  ended_at: string | null;
}

interface AgentTurnEventRow {
  id: number;
  turn_id: number;
  type: string;
  payload: string | null;
  source: string;
  created_at: string;
}

export interface CreateAgentTurnData {
  taskId: number;
  unitId?: number | null;
  kind: AgentTurnKind;
  phase?: string | null;
  nonce: string;
  serverName?: string | null;
  tmuxTarget?: string | null;
  outputFilePath?: string | null;
}

export interface MarkAgentTurnEndedData {
  status: AgentTurnStatus;
  completionSource: AgentTurnCompletionSource;
  confidence: AgentTurnConfidence;
  /** Defaults to now (SQLite `datetime('now')`) when omitted. */
  endedAt?: string;
}

export interface AppendAgentTurnEventData {
  type: string;
  payload?: string | null;
  source: string;
}

function truncatePayload(payload: string | null | undefined): string | null {
  if (payload == null) return null;
  const bytes = Buffer.byteLength(payload, 'utf-8');
  if (bytes <= MAX_EVENT_PAYLOAD_BYTES) return payload;
  // Truncate on a byte boundary and re-decode, dropping any partial
  // multi-byte character at the cut point.
  return Buffer.from(payload, 'utf-8').subarray(0, MAX_EVENT_PAYLOAD_BYTES).toString('utf-8');
}

export class SqliteAgentTurnRepository {
  private createStmt;
  private getStmt;
  private latestByTaskPhaseStmt;
  private latestByTaskStmt;
  private findRunningByTaskStmt;
  private markEndedStmt;
  private supersedeRunningStmt;
  private supersedeRunningExceptStmt;
  private appendEventStmt;
  private latestEventByTypeStmt;

  constructor(private db: SqliteDatabase) {
    this.createStmt = db.prepare(
      `INSERT INTO agent_turns (task_id, unit_id, kind, phase, nonce, server_name, tmux_target, output_file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getStmt = db.prepare('SELECT * FROM agent_turns WHERE id = ?');
    this.latestByTaskPhaseStmt = db.prepare(
      'SELECT * FROM agent_turns WHERE task_id = ? AND phase = ? ORDER BY id DESC LIMIT 1',
    );
    this.latestByTaskStmt = db.prepare('SELECT * FROM agent_turns WHERE task_id = ? ORDER BY id DESC LIMIT 1');
    this.findRunningByTaskStmt = db.prepare(
      "SELECT * FROM agent_turns WHERE task_id = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
    );
    this.markEndedStmt = db.prepare(
      "UPDATE agent_turns SET status = ?, completion_source = ?, confidence = ?, ended_at = ? WHERE id = ?",
    );
    this.supersedeRunningStmt = db.prepare(
      "UPDATE agent_turns SET status = 'superseded', ended_at = datetime('now') WHERE task_id = ? AND status = 'running'",
    );
    this.supersedeRunningExceptStmt = db.prepare(
      "UPDATE agent_turns SET status = 'superseded', ended_at = datetime('now') WHERE task_id = ? AND status = 'running' AND id != ?",
    );
    this.appendEventStmt = db.prepare(
      'INSERT INTO agent_turn_events (turn_id, type, payload, source) VALUES (?, ?, ?, ?)',
    );
    this.latestEventByTypeStmt = db.prepare(
      'SELECT * FROM agent_turn_events WHERE turn_id = ? AND type = ? ORDER BY id DESC LIMIT 1',
    );
  }

  create(data: CreateAgentTurnData): AgentTurn {
    const result = this.createStmt.run(
      data.taskId,
      data.unitId ?? null,
      data.kind,
      data.phase ?? null,
      data.nonce,
      data.serverName ?? null,
      data.tmuxTarget ?? null,
      data.outputFilePath ?? null,
    );
    const turn = this.findById(Number(result.lastInsertRowid));
    if (!turn) throw new Error('Failed to create agent turn: row not found after insert');
    return turn;
  }

  findById(id: number): AgentTurn | null {
    const row = this.getStmt.get(id) as AgentTurnRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  findLatestByTaskPhase(taskId: number, phase: string): AgentTurn | null {
    const row = this.latestByTaskPhaseStmt.get(taskId, phase) as AgentTurnRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  findLatestByTask(taskId: number): AgentTurn | null {
    const row = this.latestByTaskStmt.get(taskId) as AgentTurnRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  /** Most recent `running` turn for the task, or null when none is currently running. */
  findRunningByTask(taskId: number): AgentTurn | null {
    const row = this.findRunningByTaskStmt.get(taskId) as AgentTurnRow | undefined;
    return row ? this.toEntity(row) : null;
  }

  markEnded(id: number, data: MarkAgentTurnEndedData): void {
    this.markEndedStmt.run(
      data.status,
      data.completionSource,
      data.confidence,
      data.endedAt ?? new Date().toISOString(),
      id,
    );
  }

  /** Marks any still-`running` turns for the task as `superseded`, optionally excluding one turn id. */
  supersedeRunning(taskId: number, exceptTurnId?: number): void {
    if (exceptTurnId === undefined) {
      this.supersedeRunningStmt.run(taskId);
    } else {
      this.supersedeRunningExceptStmt.run(taskId, exceptTurnId);
    }
  }

  appendEvent(turnId: number, data: AppendAgentTurnEventData): void {
    this.appendEventStmt.run(turnId, data.type, truncatePayload(data.payload), data.source);
  }

  /** Most recent event of `type` recorded against `turnId`, or null when none exists. */
  findLatestEventByType(turnId: number, type: string): AgentTurnEvent | null {
    const row = this.latestEventByTypeStmt.get(turnId, type) as AgentTurnEventRow | undefined;
    return row ? this.toEventEntity(row) : null;
  }

  private toEventEntity(row: AgentTurnEventRow): AgentTurnEvent {
    return {
      id: row.id,
      turnId: row.turn_id,
      type: row.type,
      payload: row.payload,
      source: row.source,
      createdAt: row.created_at,
    };
  }

  private toEntity(row: AgentTurnRow): AgentTurn {
    return {
      id: row.id,
      taskId: row.task_id,
      unitId: row.unit_id,
      kind: row.kind as AgentTurnKind,
      phase: row.phase,
      nonce: row.nonce,
      status: row.status as AgentTurnStatus,
      completionSource: row.completion_source as AgentTurnCompletionSource | null,
      confidence: row.confidence as AgentTurnConfidence | null,
      serverName: row.server_name,
      tmuxTarget: row.tmux_target,
      outputFilePath: row.output_file_path,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    };
  }
}
