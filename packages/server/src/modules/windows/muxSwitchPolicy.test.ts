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
  it.each([
    ['tmux', 'tmux', 'ask', true, 'ask'],
    ['tmux', 'tmux', 'ask', false, null],
    ['tmux', 'tmux', 'misao', true, 'ask'],
    ['tmux', 'tmux', 'misao', false, 'misao_unavailable'],
    ['tmux', 'tmux', 'tmux', true, null],
    ['tmux', 'tmux', 'tmux', false, null],
    ['tmux', 'misao', 'ask', true, null],
    ['tmux', 'misao', 'ask', false, null],
    ['tmux', 'misao', 'misao', true, null],
    ['tmux', 'misao', 'misao', false, null],
    ['tmux', 'misao', 'tmux', true, null],
    ['tmux', 'misao', 'tmux', false, null],
    ['misao', 'tmux', 'ask', true, null],
    ['misao', 'tmux', 'ask', false, null],
    ['misao', 'tmux', 'misao', true, null],
    ['misao', 'tmux', 'misao', false, null],
    ['misao', 'tmux', 'tmux', true, null],
    ['misao', 'tmux', 'tmux', false, null],
    ['misao', 'misao', 'ask', true, null],
    ['misao', 'misao', 'ask', false, null],
    ['misao', 'misao', 'misao', true, null],
    ['misao', 'misao', 'misao', false, null],
    ['misao', 'misao', 'tmux', true, null],
    ['misao', 'misao', 'tmux', false, null],
  ] as const)('%s → %s, %s, available=%s', (source, target, mode, available, expected) => {
    expect(decideAutoWake(source, target, mode, available)).toBe(expected);
  });
});
