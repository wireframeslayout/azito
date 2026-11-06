import type Database from 'better-sqlite3';

export const version = 83;
export const description = 'Record Claude configuration directories for window conversations';

export function up(db: Database.Database): void {
  db.exec('ALTER TABLE windows ADD COLUMN claude_config_dir TEXT');
  db.exec('ALTER TABLE windows ADD COLUMN claude_pane_sessions TEXT');
  db.exec('ALTER TABLE windows ADD COLUMN claude_config_dir_explicit INTEGER');
}
