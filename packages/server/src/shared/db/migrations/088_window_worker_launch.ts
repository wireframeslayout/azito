import type { Database } from 'better-sqlite3';

export const version = 88;
export const description = 'Record window worker launch settings';
export function up(db: Database): void {
  db.exec('ALTER TABLE windows ADD COLUMN worker_launch TEXT');
}
