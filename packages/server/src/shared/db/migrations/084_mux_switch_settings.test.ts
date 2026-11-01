import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from './084_mux_switch_settings';

describe('mux switch settings migration', () => {
  it('seeds one row that asks by default', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      expect(db.prepare('SELECT id, mode FROM mux_switch_settings').all()).toEqual([{ id: 1, mode: 'ask' }]);
    } finally { db.close(); }
  });
  it('refuses an unknown mode and a second row', () => {
    const db = new Database(':memory:');
    try {
      up(db);
      expect(() => db.prepare("UPDATE mux_switch_settings SET mode = 'invalid' WHERE id = 1").run()).toThrow();
      expect(() => db.prepare('INSERT INTO mux_switch_settings (id) VALUES (2)').run()).toThrow();
    } finally { db.close(); }
  });
});
