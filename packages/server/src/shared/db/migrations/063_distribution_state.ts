import type Database from 'better-sqlite3';

export const version = 63;
export const description = 'distribution_state — tracks last-distributed SHA per server×repository for hub-transfer incremental bundles (Issue #87)';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS distribution_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_name TEXT NOT NULL,
      repository_id INTEGER NOT NULL,
      last_distributed_sha TEXT NOT NULL,
      bundle_type TEXT NOT NULL DEFAULT 'full',
      distributed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(server_name, repository_id),
      FOREIGN KEY (repository_id) REFERENCES project_repositories(id) ON DELETE CASCADE
    )
  `);
}
