import type { Database } from 'better-sqlite3';

export const version = 9;
export const description = 'Add storage_settings table for MinIO/S3 configuration';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      endpoint TEXT NOT NULL DEFAULT 'http://localhost:9000',
      access_key TEXT NOT NULL DEFAULT 'minioadmin',
      secret_key TEXT NOT NULL DEFAULT 'minioadmin',
      bucket TEXT NOT NULL DEFAULT 'azito-files',
      region TEXT NOT NULL DEFAULT 'us-east-1',
      max_file_size INTEGER NOT NULL DEFAULT 52428800,
      use_ssl INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    INSERT OR IGNORE INTO storage_settings (id) VALUES (1)
  `);
}
