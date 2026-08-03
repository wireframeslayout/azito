import type Database from 'better-sqlite3';

export const version = 30;
export const description = 'Add agent_session_id to tasks';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN agent_session_id TEXT`);
}
