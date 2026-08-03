import type { SqliteDatabase } from '../../shared/db/Database';
import type { ExecutionLog, LogType, IExecutionLogRepository } from './ExecutionLog';

interface LogRow {
  id: number;
  task_id: number | null;
  unit_id: number;
  type: string;
  content: string | null;
  created_at: string;
}

export class SqliteExecutionLogRepository implements IExecutionLogRepository {
  private appendStmt;
  private byTaskStmt;
  private byUnitStmt;

  constructor(private db: SqliteDatabase) {
    this.appendStmt = db.prepare('INSERT INTO execution_log (task_id, unit_id, type, content) VALUES (?, ?, ?, ?)');
    this.byTaskStmt = db.prepare('SELECT * FROM execution_log WHERE task_id = ? ORDER BY created_at');
    this.byUnitStmt = db.prepare('SELECT * FROM execution_log WHERE unit_id = ? ORDER BY created_at DESC LIMIT ?');
  }

  append(taskId: number | null, unitId: number, type: LogType, content: unknown): void {
    const serialized = typeof content === 'string' ? content : JSON.stringify(content);
    this.appendStmt.run(taskId, unitId, type, serialized);
  }

  findByTask(taskId: number): ExecutionLog[] {
    return (this.byTaskStmt.all(taskId) as LogRow[]).map((r) => this.toEntity(r));
  }

  findByUnit(unitId: number, limit = 100): ExecutionLog[] {
    return (this.byUnitStmt.all(unitId, limit) as LogRow[]).map((r) => this.toEntity(r));
  }

  private toEntity(row: LogRow): ExecutionLog {
    return {
      id: row.id,
      taskId: row.task_id,
      unitId: row.unit_id,
      type: row.type as LogType,
      content: row.content ?? '',
      createdAt: row.created_at,
    };
  }
}
