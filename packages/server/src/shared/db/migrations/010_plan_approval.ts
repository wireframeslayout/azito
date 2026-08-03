import type Database from 'better-sqlite3';

export const version = 10;
export const description = 'Add require_plan_approval to tasks';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN require_plan_approval INTEGER NOT NULL DEFAULT 1`);
}
