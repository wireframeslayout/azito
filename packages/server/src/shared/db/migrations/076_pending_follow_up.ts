import type Database from 'better-sqlite3';

export const version = 76;
export const description = 'Add pending_follow_up_body and pending_follow_up_phases columns to tasks';

export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const existing = new Set(cols.map((c) => c.name));
  if (!existing.has('pending_follow_up_body')) {
    db.exec("ALTER TABLE tasks ADD COLUMN pending_follow_up_body TEXT DEFAULT NULL");
  }
  if (!existing.has('pending_follow_up_phases')) {
    db.exec("ALTER TABLE tasks ADD COLUMN pending_follow_up_phases TEXT DEFAULT NULL");
  }
}
