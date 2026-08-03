import type { Database } from 'better-sqlite3';

export const version = 13;
export const description = 'Add icon and color columns to projects';

export function up(db: Database): void {
  db.exec(`ALTER TABLE projects ADD COLUMN icon TEXT`);
  db.exec(`ALTER TABLE projects ADD COLUMN color TEXT`);
}
