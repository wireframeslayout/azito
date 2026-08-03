import type Database from 'better-sqlite3';

export const version = 32;
export const description = 'Add working_directory to tasks';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN working_directory TEXT`);
}
