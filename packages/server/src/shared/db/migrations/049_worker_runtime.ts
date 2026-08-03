import type Database from 'better-sqlite3';

export const version = 49;
export const description = 'Add worker_runtime column to units table';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE units ADD COLUMN worker_runtime TEXT NOT NULL DEFAULT 'tui'`);
}
