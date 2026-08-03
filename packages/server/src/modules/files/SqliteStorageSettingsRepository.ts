import type { Database } from 'better-sqlite3';
import type { StorageSettings } from './storage/MinioStorageClient';
import { seal, open } from '../../shared/crypto/SecretBox';

export interface IStorageSettingsRepository {
  get(): StorageSettings;
  update(settings: Partial<StorageSettings>): void;
}

export class SqliteStorageSettingsRepository implements IStorageSettingsRepository {
  constructor(private db: Database) {}

  get(): StorageSettings {
    const row = this.db.prepare('SELECT * FROM storage_settings WHERE id = 1').get() as {
      endpoint: string;
      access_key: string;
      secret_key: string;
      bucket: string;
      region: string;
      max_file_size: number;
      use_ssl: number;
    };
    return {
      endpoint: row.endpoint,
      accessKey: open(row.access_key) as string,
      secretKey: open(row.secret_key) as string,
      bucket: row.bucket,
      region: row.region,
      maxFileSize: row.max_file_size,
      useSsl: row.use_ssl === 1,
    };
  }

  update(settings: Partial<StorageSettings>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (settings.endpoint !== undefined) { fields.push('endpoint = ?'); values.push(settings.endpoint); }
    if (settings.accessKey !== undefined) { fields.push('access_key = ?'); values.push(seal(settings.accessKey)); }
    if (settings.secretKey !== undefined) { fields.push('secret_key = ?'); values.push(seal(settings.secretKey)); }
    if (settings.bucket !== undefined) { fields.push('bucket = ?'); values.push(settings.bucket); }
    if (settings.region !== undefined) { fields.push('region = ?'); values.push(settings.region); }
    if (settings.maxFileSize !== undefined) { fields.push('max_file_size = ?'); values.push(settings.maxFileSize); }
    if (settings.useSsl !== undefined) { fields.push('use_ssl = ?'); values.push(settings.useSsl ? 1 : 0); }

    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");

    this.db.prepare(`UPDATE storage_settings SET ${fields.join(', ')} WHERE id = 1`).run(...values);
  }
}
