import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { DataPaths, LegacyPaths } from './dataDir';
import { migrateDataIfNeeded } from './dataMigration';

function createLegacyLayout(dir: string): { legacyPaths: LegacyPaths; sealedValue: string } {
  const dataSubdir = path.join(dir, 'data');
  fs.mkdirSync(dataSubdir, { recursive: true });

  const dbPath = path.join(dir, 'data.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE test_secrets (id INTEGER PRIMARY KEY, value TEXT)');

  const masterKey = crypto.randomBytes(32);
  const keyPath = path.join(dataSubdir, 'master.key');
  fs.writeFileSync(keyPath, masterKey.toString('hex'), { mode: 0o600 });

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const encrypted = Buffer.concat([cipher.update('secret-data', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const sealed = `v1.${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;

  db.prepare('INSERT INTO test_secrets (value) VALUES (?)').run(sealed);
  db.close();

  const vapidPath = path.join(dataSubdir, 'vapid-keys.json');
  fs.writeFileSync(vapidPath, JSON.stringify({ publicKey: 'pub', privateKey: 'priv' }));

  return {
    legacyPaths: {
      db: dbPath,
      masterKey: keyPath,
      vapidKeys: vapidPath,
      browserProfile: path.join(dataSubdir, 'browser-profile'),
    },
    sealedValue: sealed,
  };
}

function makeDataPaths(dir: string): DataPaths {
  return {
    dir,
    db: path.join(dir, 'data.db'),
    masterKey: path.join(dir, 'master.key'),
    vapidKeys: path.join(dir, 'vapid-keys.json'),
    uiToken: path.join(dir, 'ui-token'),
    browserProfile: path.join(dir, 'browser-profile'),
    sidekicks: path.join(dir, 'sidekicks'),
    updateState: path.join(dir, 'update-state.json'),
    updateLog: path.join(dir, 'update.log'),
    updateChannel: path.join(dir, 'update-channel.json'),
  };
}

describe('migrateDataIfNeeded', () => {
  let tmpDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-migration-test-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates WAL-mode DB and preserves encrypted column decryption', () => {
    const legacyDir = path.join(tmpDir, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    const { legacyPaths, sealedValue } = createLegacyLayout(legacyDir);

    const newDir = path.join(tmpDir, 'new-data');
    fs.mkdirSync(newDir, { recursive: true, mode: 0o700 });
    const newPaths = makeDataPaths(newDir);

    migrateDataIfNeeded(newPaths, legacyPaths);

    expect(fs.existsSync(newPaths.db)).toBe(true);
    expect(fs.existsSync(newPaths.masterKey)).toBe(true);
    expect(fs.existsSync(newPaths.vapidKeys)).toBe(true);

    const migratedDb = new Database(newPaths.db);
    const row = migratedDb.prepare('SELECT value FROM test_secrets WHERE id = 1').get() as { value: string };
    migratedDb.close();
    expect(row.value).toBe(sealedValue);

    const masterKeyHex = fs.readFileSync(newPaths.masterKey, 'utf-8').trim();
    const masterKey = Buffer.from(masterKeyHex, 'hex');
    const parts = sealedValue.split('.');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const encrypted = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    expect(decrypted).toBe('secret-data');
  });

  it('exits with error when only data.db exists at new path and master.key at legacy', () => {
    const legacyDir = path.join(tmpDir, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    const { legacyPaths } = createLegacyLayout(legacyDir);

    const newDir = path.join(tmpDir, 'new-data');
    fs.mkdirSync(newDir, { recursive: true });
    const newPaths = makeDataPaths(newDir);

    fs.writeFileSync(newPaths.db, 'dummy');

    expect(() => migrateDataIfNeeded(newPaths, legacyPaths)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error when only master.key exists at new path and data.db at legacy', () => {
    const legacyDir = path.join(tmpDir, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    const { legacyPaths } = createLegacyLayout(legacyDir);

    const newDir = path.join(tmpDir, 'new-data');
    fs.mkdirSync(newDir, { recursive: true });
    const newPaths = makeDataPaths(newDir);

    fs.writeFileSync(newPaths.masterKey, 'dummy');

    expect(() => migrateDataIfNeeded(newPaths, legacyPaths)).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not leave partial files when rename fails mid-loop', () => {
    const legacyDir = path.join(tmpDir, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    const { legacyPaths } = createLegacyLayout(legacyDir);

    const newDir = path.join(tmpDir, 'new-data');
    fs.mkdirSync(newDir, { recursive: true, mode: 0o700 });
    const newPaths = makeDataPaths(newDir);

    const origRenameSync = fs.renameSync;
    let callCount = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
      callCount++;
      if (callCount >= 2) {
        throw new Error('Simulated rename failure');
      }
      origRenameSync(src as string, dest as string);
    });

    expect(() => migrateDataIfNeeded(newPaths, legacyPaths)).toThrow('process.exit called');

    expect(fs.existsSync(newPaths.db)).toBe(false);
    expect(fs.existsSync(newPaths.masterKey)).toBe(false);

    vi.restoreAllMocks();
  });

  it('is a no-op when paths are identical (AZITO_DATA_DIR unset)', () => {
    const legacyDir = path.join(tmpDir, 'same');
    fs.mkdirSync(legacyDir, { recursive: true });
    const { legacyPaths } = createLegacyLayout(legacyDir);

    const samePaths: DataPaths = {
      dir: legacyDir,
      db: legacyPaths.db,
      masterKey: legacyPaths.masterKey,
      vapidKeys: legacyPaths.vapidKeys,
      uiToken: path.join(legacyDir, 'data', 'ui-token'),
      browserProfile: legacyPaths.browserProfile,
      sidekicks: path.join(legacyDir, 'data', 'sidekicks'),
      updateState: path.join(legacyDir, 'data', 'update-state.json'),
      updateLog: path.join(legacyDir, 'data', 'update.log'),
      updateChannel: path.join(legacyDir, 'data', 'update-channel.json'),
    };

    migrateDataIfNeeded(samePaths, legacyPaths);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
