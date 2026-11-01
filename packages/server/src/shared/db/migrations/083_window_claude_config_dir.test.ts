import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { up } from './083_window_claude_config_dir';
import { openDatabase } from '../Database';
import { createSecretFileGuard } from '../../os/secretFileGuard';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('window Claude configuration migration', () => {
  it.each([false, true])('applies after an existing database with 082 present: %s', (has082) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'azito-migration-083-'));
    const dbPath = path.join(dir, 'data.db');
    const secretFileGuard = createSecretFileGuard(process.platform, process.env);
    try {
      const db = openDatabase(dbPath, { secretFileGuard });
      db.exec('ALTER TABLE windows DROP COLUMN claude_config_dir; ALTER TABLE windows DROP COLUMN claude_pane_sessions; ALTER TABLE windows DROP COLUMN claude_config_dir_explicit; DELETE FROM _migrations WHERE version = 83');
      if (has082) db.prepare("INSERT INTO _migrations (version, description) VALUES (82, 'other series')").run();
      db.close();
      const migrated = openDatabase(dbPath, { secretFileGuard });
      expect(migrated.prepare('SELECT version FROM _migrations WHERE version = 83').get()).toEqual({ version: 83 });
      expect(migrated.prepare('SELECT claude_config_dir, claude_pane_sessions FROM windows').all()).toEqual([]);
      migrated.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves existing windows without a recorded configuration directory', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE windows (id INTEGER PRIMARY KEY); INSERT INTO windows DEFAULT VALUES');
    up(db);
    expect(db.prepare('SELECT claude_config_dir, claude_pane_sessions FROM windows').get()).toEqual({
      claude_config_dir: null, claude_pane_sessions: null,
    });
    db.close();
  });
});

