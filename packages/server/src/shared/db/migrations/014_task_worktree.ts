import type { Database } from 'better-sqlite3';

export const version = 14;
export const description = 'Add worktree_path, worktree_branch, base_branch to tasks';

export function up(db: Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN worktree_path TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN worktree_branch TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN base_branch TEXT`);
}
