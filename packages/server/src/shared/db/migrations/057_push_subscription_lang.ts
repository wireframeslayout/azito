export const version = 57;
export const description = 'Add lang column to push_subscriptions for i18n';

export function up(db: import('better-sqlite3').Database): void {
  db.exec("ALTER TABLE push_subscriptions ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'");
}
