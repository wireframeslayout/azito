import type { Database } from 'better-sqlite3';

export const version = 56;
export const description = 'Drop windows.supervised column (agent windows are always supervised)';

export function up(db: Database): void {
  db.exec('ALTER TABLE windows DROP COLUMN supervised');
}
