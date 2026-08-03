import type { Database } from 'better-sqlite3';

export const version = 6;
export const description = 'Add orchestrator_mode and self_review_max_attempts to tasks';

export function up(db: Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN orchestrator_mode TEXT DEFAULT NULL`);
  db.exec(`ALTER TABLE tasks ADD COLUMN self_review_max_attempts INTEGER DEFAULT NULL`);
}
