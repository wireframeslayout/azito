import type { Database } from 'better-sqlite3';

export interface ResourceGuardSettings {
  enabled: boolean;
  memAvailablePercentMin: number;
  loadPerCoreMax: number;
}

export interface IResourceGuardSettingsRepository {
  get(): ResourceGuardSettings;
  update(settings: Partial<ResourceGuardSettings>): void;
}

export class SqliteResourceGuardSettingsRepository implements IResourceGuardSettingsRepository {
  constructor(private db: Database) {}

  get(): ResourceGuardSettings {
    const row = this.db.prepare('SELECT * FROM resource_guard_settings WHERE id = 1').get() as {
      enabled: number;
      mem_available_percent_min: number;
      load_per_core_max: number;
    };
    return {
      enabled: row.enabled === 1,
      memAvailablePercentMin: row.mem_available_percent_min,
      loadPerCoreMax: row.load_per_core_max,
    };
  }

  update(settings: Partial<ResourceGuardSettings>): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (settings.enabled !== undefined) { fields.push('enabled = ?'); values.push(settings.enabled ? 1 : 0); }
    if (settings.memAvailablePercentMin !== undefined) { fields.push('mem_available_percent_min = ?'); values.push(settings.memAvailablePercentMin); }
    if (settings.loadPerCoreMax !== undefined) { fields.push('load_per_core_max = ?'); values.push(settings.loadPerCoreMax); }

    if (fields.length === 0) return;
    fields.push("updated_at = datetime('now')");

    this.db.prepare(`UPDATE resource_guard_settings SET ${fields.join(', ')} WHERE id = 1`).run(...values);
  }
}
