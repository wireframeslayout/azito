import type { Database } from 'better-sqlite3';

export interface LookoutSettings {
  enabled: boolean;
  provider: 'claude' | 'codex';
  model: string;
  updatedAt: string;
}

export class SqliteLookoutSettingsRepository {
  constructor(private readonly db: Database) {}

  get(): LookoutSettings {
    const row = this.db.prepare('SELECT enabled, provider, model, updated_at FROM lookout_settings WHERE id = 1').get() as {
      enabled: number; provider: LookoutSettings['provider']; model: string; updated_at: string;
    };
    return { enabled: row.enabled === 1, provider: row.provider, model: row.model, updatedAt: row.updated_at };
  }

  update(settings: Omit<LookoutSettings, 'updatedAt'>): LookoutSettings {
    this.db.prepare("UPDATE lookout_settings SET enabled = ?, provider = ?, model = ?, updated_at = datetime('now') WHERE id = 1")
      .run(settings.enabled ? 1 : 0, settings.provider, settings.model);
    return this.get();
  }
}
