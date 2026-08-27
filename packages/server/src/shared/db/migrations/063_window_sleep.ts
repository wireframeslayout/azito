export const version = 63;
export const description = 'Add window sleeping state and sleep-after-push options';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE windows ADD COLUMN sleeping INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE units ADD COLUMN sleep_after_push INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE tasks ADD COLUMN sleep_after_push INTEGER`);
}
