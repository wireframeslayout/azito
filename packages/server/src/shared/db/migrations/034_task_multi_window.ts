import type BetterSqlite3 from 'better-sqlite3';

export const version = 34;
export const description = 'Add task_windows table for multi-window support';

export function up(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      tmux_target TEXT NOT NULL,
      label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_windows_task_id ON task_windows(task_id)');
}
