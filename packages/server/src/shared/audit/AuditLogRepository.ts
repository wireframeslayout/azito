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

/** A stored row as read back (Issue #28 Phase D-4) — `detail` is parsed from its JSON column back into an object, `null` if the row had none or the stored JSON is malformed (never throws on read). */
export interface AuditLogRow {
  id: number;
  ts: string;
  actorClass: PrincipalClass;
  actorId: number | null;
  event: string;
  detail: Record<string, unknown> | null;
}

export interface IAuditLogRepository {
  record(entry: AuditLogEntry): void;
  /** Most recent rows first (`id DESC`), capped at `limit`. Read-only — used only by the operator-only `GET /api/audit-log` route (Issue #28 Phase D-4), never by anything that gates a security decision on it. */
  listRecent(limit: number): AuditLogRow[];
}

interface AuditLogRowRaw {
  id: number;
  ts: string;
  actor_class: PrincipalClass;
  actor_id: number | null;
  event: string;
  detail: string | null;
}

export class SqliteAuditLogRepository implements IAuditLogRepository {
  private insertStmt;
  private listRecentStmt;

  constructor(private db: SqliteDatabase) {
    this.insertStmt = db.prepare(
      "INSERT INTO audit_log (ts, actor_class, actor_id, event, detail) VALUES (datetime('now'), ?, ?, ?, ?)",
    );
    this.listRecentStmt = db.prepare(
      'SELECT id, ts, actor_class, actor_id, event, detail FROM audit_log ORDER BY id DESC LIMIT ?',
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

  listRecent(limit: number): AuditLogRow[] {
    const rows = this.listRecentStmt.all(limit) as AuditLogRowRaw[];
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      actorClass: row.actor_class,
      actorId: row.actor_id,
      event: row.event,
      detail: parseDetail(row.detail),
    }));
  }
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
