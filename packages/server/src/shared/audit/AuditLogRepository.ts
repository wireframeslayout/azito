import type { Database as SqliteDatabase } from 'better-sqlite3';
import type { PrincipalClass } from '../auth/Principal';

/**
 * Operational record, not tamper-evident (design v3 §0/§10: "監査ログは運用上
 * の記録であり改ざん耐性は主張しない"). `detail` must never contain the
 * Authorization header, request body, secret values, or turnToken (design v3
 * §10) — callers are responsible for building a redacted detail object
 * before calling record().
 */
export interface AuditLogEntry {
  actorClass: PrincipalClass;
  actorId?: number | null;
  event: string;
  detail?: Record<string, unknown>;
}

export interface IAuditLogRepository {
  record(entry: AuditLogEntry): void;
}

export class SqliteAuditLogRepository implements IAuditLogRepository {
  private insertStmt;

  constructor(private db: SqliteDatabase) {
    this.insertStmt = db.prepare(
      "INSERT INTO audit_log (ts, actor_class, actor_id, event, detail) VALUES (datetime('now'), ?, ?, ?, ?)",
    );
  }

  record(entry: AuditLogEntry): void {
    this.insertStmt.run(
      entry.actorClass,
      entry.actorId ?? null,
      entry.event,
      entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
    );
  }
}
