import type Database from 'better-sqlite3';

export const version = 81;
export const description = 'Record whether a window label was set by a user';

export function up(db: Database.Database): void {
  db.exec("ALTER TABLE windows ADD COLUMN label_source TEXT NOT NULL DEFAULT 'auto' CHECK (label_source IN ('auto', 'user'))");
}
