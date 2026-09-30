export const version = 74;
export const description = 'Add herdr_navigation_lock to servers and windows';

export function up(db: import('better-sqlite3').Database): void {
  db.exec(`ALTER TABLE servers ADD COLUMN herdr_navigation_lock TEXT NOT NULL DEFAULT 'locked'`);
  db.exec(`ALTER TABLE windows ADD COLUMN herdr_navigation_lock TEXT NULL`);
}
