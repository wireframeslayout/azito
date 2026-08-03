import type Database from 'better-sqlite3';

export const version = 48;
export const description = 'Add unit_type column to units table';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE units ADD COLUMN unit_type TEXT NOT NULL DEFAULT 'devops'`);
}
