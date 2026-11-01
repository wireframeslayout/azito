import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up as createStorage } from './009_storage_settings';
import { up } from './081_storage_settings_configured';
import { seal } from '../../crypto/SecretBox';

describe('storage configured migration', () => {
  it('leaves default settings unconfigured and backfills changed encrypted credentials', () => {
    const previous = process.env.AZITO_MASTER_KEY;
    process.env.AZITO_MASTER_KEY = '1'.repeat(64);
    const db = new Database(':memory:');
    try {
      createStorage(db);
      db.prepare('UPDATE storage_settings SET access_key = ?, secret_key = ?').run(seal('minioadmin'), seal('minioadmin'));
      up(db);
      expect(db.prepare('SELECT configured FROM storage_settings').get()).toEqual({ configured: 0 });
    } finally { db.close(); if (previous === undefined) delete process.env.AZITO_MASTER_KEY; else process.env.AZITO_MASTER_KEY = previous; }
  });
  it('marks changed settings configured', () => {
    const db = new Database(':memory:');
    try {
      createStorage(db);
      db.prepare('UPDATE storage_settings SET bucket = ?').run('custom');
      up(db);
      expect(db.prepare('SELECT configured FROM storage_settings').get()).toEqual({ configured: 1 });
    } finally { db.close(); }
  });
});
