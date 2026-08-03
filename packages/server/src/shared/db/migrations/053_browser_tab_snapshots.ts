export const version = 53;
export const description = 'browser tab snapshots for restart-durable URL restore';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_tab_snapshots (
      server_name TEXT NOT NULL,
      group_id    TEXT NOT NULL,
      tab_id      TEXT NOT NULL,
      url         TEXT,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (server_name, group_id, tab_id)
    );
  `);
}
