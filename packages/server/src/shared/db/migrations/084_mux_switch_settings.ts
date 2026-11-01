import type { Database } from 'better-sqlite3';

export const version = 84;
export const description = 'Add wake mux switch policy';

export function up(db: Database): void {
  db.exec(`CREATE TABLE mux_switch_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'ask' CHECK (mode IN ('ask', 'misao', 'tmux')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); INSERT INTO mux_switch_settings (id) VALUES (1);`);
}
