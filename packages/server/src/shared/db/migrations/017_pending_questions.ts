export const version = 17;
export const description = 'Add pending_questions column to tasks';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE tasks ADD COLUMN pending_questions TEXT DEFAULT NULL`);
}
