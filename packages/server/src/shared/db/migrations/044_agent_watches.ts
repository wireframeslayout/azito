import type Database from 'better-sqlite3';

export const version = 44;
export const description = 'Add agent_watches table for idle push-notification subscriptions on a server/target pane';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agent_watches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      server_name TEXT NOT NULL,
      target TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(endpoint, server_name, target)
    )
  `);
}
