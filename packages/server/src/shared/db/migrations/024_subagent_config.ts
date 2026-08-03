export const version = 24;
export const description = 'Add subagent config columns to sidekicks and tasks';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE sidekicks ADD COLUMN review_subagent TEXT`);
  db.exec(`ALTER TABLE sidekicks ADD COLUMN implement_subagent TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN review_subagent TEXT`);
  db.exec(`ALTER TABLE tasks ADD COLUMN implement_subagent TEXT`);
}
