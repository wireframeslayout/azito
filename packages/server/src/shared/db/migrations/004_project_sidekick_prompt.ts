import type { Database } from 'better-sqlite3';

export const version = 4;
export const description = 'Add sidekick_prompt column to projects';

export function up(db: Database): void {
  try {
    db.exec('ALTER TABLE projects ADD COLUMN sidekick_prompt TEXT');
  } catch {
    // column may already exist
  }
}
