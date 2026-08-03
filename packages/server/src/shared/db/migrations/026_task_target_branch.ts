import type Database from 'better-sqlite3';

export const version = 26;
export const description = 'Add target_branch to tasks';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN target_branch TEXT`);
}
