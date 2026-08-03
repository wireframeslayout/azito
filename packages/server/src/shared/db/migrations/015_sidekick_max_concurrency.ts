import type { Database } from 'better-sqlite3';

export const version = 15;
export const description = 'Add max_concurrency to sidekicks';

export function up(db: Database): void {
  db.exec(`ALTER TABLE sidekicks ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 1`);
}
