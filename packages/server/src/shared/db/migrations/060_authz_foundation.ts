import type Database from 'better-sqlite3';

export const version = 60;
export const description = 'task_tokens capability table + audit_log (Issue #28 Phase A)';

export function up(db: Database.Database): void {
  // Capability row per issued task token (design v3 §2). Plaintext is never
  // stored — only sha256(secret). No column is added to `tasks` for this
  // (design v3 §2: "tasks への列追加はしない（履歴を null 化で消さない）"), so
  // a task's token history survives independently of the task row's own
  // lifecycle; `task_id` intentionally has no FOREIGN KEY (with cascade or
  // without) so that DELETE FROM tasks never needs a matching cascade rule —
  // SqliteTaskRepository.delete()/updateStatus() explicitly revoke (not
  // delete) matching rows in the same transaction before/around the tasks
  // write (see that file's revocation comment).
  db.exec(`
    CREATE TABLE task_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      window_generation INTEGER NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      revoke_reason TEXT
    )
  `);
  db.exec('CREATE INDEX idx_task_tokens_task_id ON task_tokens(task_id)');
  // A token hash must uniquely identify at most one row — guards against a
  // secret collision (astronomically unlikely with 32 random bytes, but
  // cheap to enforce) ever verifying against the wrong task.
  db.exec('CREATE UNIQUE INDEX idx_task_tokens_hash ON task_tokens(token_hash)');

  // Operational audit trail (design v3 §10). Not tamper-evident — see the
  // doc comment on shared/audit/AuditLogRepository.ts. `detail` is a JSON
  // blob and must never carry Authorization headers, request bodies, secret
  // values, or turnToken (callers redact before calling record()).
  db.exec(`
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      actor_class TEXT NOT NULL,
      actor_id INTEGER,
      event TEXT NOT NULL,
      detail TEXT
    )
  `);
  db.exec('CREATE INDEX idx_audit_log_ts ON audit_log(ts)');
}
