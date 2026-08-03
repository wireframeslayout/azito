import type { Database } from 'better-sqlite3';

export const version = 50;
export const description = 'Add supervised flag to windows table';

export function up(db: Database): void {
  db.exec(`ALTER TABLE windows ADD COLUMN supervised INTEGER NOT NULL DEFAULT 0`);
}
