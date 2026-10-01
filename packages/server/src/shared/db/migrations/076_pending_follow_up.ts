import type Database from 'better-sqlite3';

export const version = 76;
export const description = 'Add pending_follow_up_body and pending_follow_up_phases columns to tasks';

export function up(db: Database.Database): void {
  db.exec("ALTER TABLE tasks ADD COLUMN pending_follow_up_body TEXT DEFAULT NULL");
  db.exec("ALTER TABLE tasks ADD COLUMN pending_follow_up_phases TEXT DEFAULT NULL");
}
