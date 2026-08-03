import type Database from 'better-sqlite3';

export const version = 29;
export const description = 'Add summary_json to tasks';

export function up(db: Database.Database): void {
  db.exec('ALTER TABLE tasks ADD COLUMN summary_json TEXT');
}
