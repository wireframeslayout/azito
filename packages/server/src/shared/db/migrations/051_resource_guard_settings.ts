import type { Database } from 'better-sqlite3';

export const version = 51;
export const description = 'Add resource guard settings table';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resource_guard_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      mem_available_percent_min REAL NOT NULL DEFAULT 10,
      load_per_core_max REAL NOT NULL DEFAULT 2.0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO resource_guard_settings (id) VALUES (1);
  `);
}
