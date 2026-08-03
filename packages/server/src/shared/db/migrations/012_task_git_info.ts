import type { Database } from 'better-sqlite3';

export const version = 12;
export const description = 'Add branch, changed_files, pr_url to tasks';

export function up(db: Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN branch TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN changed_files TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN pr_url TEXT`);
}
