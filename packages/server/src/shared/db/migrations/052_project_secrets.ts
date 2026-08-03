import type { Database } from 'better-sqlite3';

export const version = 52;
export const description = 'Add project_secrets table';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE project_secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, name),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
}
