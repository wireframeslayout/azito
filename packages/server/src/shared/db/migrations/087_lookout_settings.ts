import type { Database } from 'better-sqlite3';

export const version = 87;
export const description = 'Add Lookout summary settings';

export function up(db: Database): void {
  db.exec(`CREATE TABLE lookout_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    provider TEXT NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'codex')),
    model TEXT NOT NULL DEFAULT 'haiku',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); INSERT INTO lookout_settings (id) VALUES (1);`);
}
