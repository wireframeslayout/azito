import type { Database } from 'better-sqlite3';

export const version = 84;
export const description = 'Add wake mux switch policy';

export function up(db: Database): void {
  db.exec(`CREATE TABLE mux_switch_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    policy TEXT NOT NULL DEFAULT 'ask' CHECK (policy IN ('ask', 'misao', 'tmux'))
  ); INSERT INTO mux_switch_settings (id) VALUES (1);`);
}
