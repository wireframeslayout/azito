import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../shared/db/migrations/084_mux_switch_settings';
import { SqliteMuxSwitchSettingsRepository } from './SqliteMuxSwitchSettingsRepository';
import { selectAutoWakeMux, shouldAskMuxSwitch } from './muxSwitchPolicy';

describe('mux switch settings', () => {
  it('defaults to ask and constrains the single row', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      const repo = new SqliteMuxSwitchSettingsRepository(db);
      expect(repo.get()).toBe('ask');
      repo.set('misao');
      expect(repo.get()).toBe('misao');
      expect(() => db.prepare("UPDATE mux_switch_settings SET policy = 'invalid'").run()).toThrow();
      expect(() => db.prepare("INSERT INTO mux_switch_settings (id) VALUES (2)").run()).toThrow();
    } finally { db.close(); }
  });
  it('asks only for an available misao on tmux under ask policy', () => {
    for (const kind of ['tmux', 'misao'] as const) {
      for (const policy of ['ask', 'misao', 'tmux'] as const) {
        for (const available of [true, false]) {
          expect(shouldAskMuxSwitch(kind, policy, available)).toBe(kind === 'tmux' && policy === 'ask' && available);
          expect(selectAutoWakeMux(kind, policy, available)).toBe(kind === 'tmux' && policy === 'misao' && available ? 'misao' : kind);
        }
      }
    }
  });
});
