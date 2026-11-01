import type { Database } from 'better-sqlite3';
import { open } from '../../crypto/SecretBox';

export const version = 81;
export const description = 'Track whether storage has been configured';

export function up(db: Database): void {
  db.exec('ALTER TABLE storage_settings ADD COLUMN configured INTEGER NOT NULL DEFAULT 0');
  const row = db.prepare('SELECT endpoint, access_key, bucket, region FROM storage_settings WHERE id = 1').get() as {
    endpoint: string; access_key: string; bucket: string; region: string;
  } | undefined;
  if (row && (row.endpoint !== 'http://localhost:9000' || open(row.access_key) !== 'minioadmin' ||
      row.bucket !== 'azito-files' || row.region !== 'us-east-1')) {
    db.prepare('UPDATE storage_settings SET configured = 1 WHERE id = 1').run();
  }
}
