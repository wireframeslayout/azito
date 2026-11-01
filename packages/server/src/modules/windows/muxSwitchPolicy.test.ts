import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from '../../shared/db/migrations/084_mux_switch_settings';
import { SqliteMuxSwitchSettingsRepository } from './SqliteMuxSwitchSettingsRepository';
import { selectAutoWakeMux, shouldAskMuxSwitch, decideAutoWake } from './muxSwitchPolicy';

describe('mux switch settings', () => {
  it('reads the saved policy and stores a new one', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      const repo = new SqliteMuxSwitchSettingsRepository(db);
      expect(repo.get()).toBe('ask');
      repo.set('misao');
      expect(repo.get()).toBe('misao');
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

describe('automatic wake notification', () => {
  it('covers all source, target, mode and availability combinations', () => {
    for (const source of ['tmux', 'misao'] as const) for (const target of ['tmux', 'misao'] as const) for (const mode of ['ask', 'misao', 'tmux'] as const) for (const available of [true, false]) {
      const expected = source !== 'tmux' || target !== 'tmux' || mode === 'tmux' ? null : available ? 'ask' : mode === 'misao' ? 'misao_unavailable' : null;
      expect(decideAutoWake(source, target, mode, available)).toBe(expected);
    }
  });
});
