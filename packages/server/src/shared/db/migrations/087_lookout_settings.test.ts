import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from './087_lookout_settings';
import { SqliteLookoutSettingsRepository } from '../../../modules/lookout/SqliteLookoutSettingsRepository';

describe('Lookout settings', () => {
  it('seeds one disabled row and persists changes', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      const repo = new SqliteLookoutSettingsRepository(db);
      expect(repo.get()).toMatchObject({ enabled: false, provider: 'claude', model: 'haiku' });
      expect(repo.update({ enabled: true, provider: 'codex', model: 'gpt-6' })).toMatchObject({ enabled: true, provider: 'codex', model: 'gpt-6' });
      expect(() => db.prepare('INSERT INTO lookout_settings (id) VALUES (2)').run()).toThrow();
    } finally { db.close(); }
  });
});
