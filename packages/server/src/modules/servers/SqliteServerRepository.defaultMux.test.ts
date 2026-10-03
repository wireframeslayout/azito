import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { SqliteDatabase } from '../../shared/db/Database';
import { SqliteServerRepository } from './SqliteServerRepository';

describe('SqliteServerRepository (default_mux / mux_runtime)', () => {
  let db: BetterSqlite3.Database;
  let repo: SqliteServerRepository;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE servers (
        name TEXT PRIMARY KEY, type TEXT NOT NULL, host TEXT, agent_port INTEGER, agent_token TEXT,
        agent_version TEXT, ssh_host TEXT, mux_runtime TEXT NOT NULL DEFAULT 'system', default_mux TEXT NOT NULL DEFAULT 'tmux',
        ssh_host_fingerprint TEXT,
        isolation_intent INTEGER DEFAULT 0, isolation_verified_at TEXT, isolation_report TEXT,
        isolation_cleanup_report TEXT, created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    repo = new SqliteServerRepository(db as unknown as SqliteDatabase);
  });

  it('creates a server on tmux / system when no mux is given', () => {
    repo.create('t', 'local');
    expect(repo.findByName('t')).toMatchObject({ defaultMux: 'tmux', muxRuntime: 'system' });
  });

  it('stores defaultMux and muxRuntime independently', () => {
    repo.create('m', 'local', undefined, undefined, undefined, undefined, undefined, 'managed', 'misao');
    expect(repo.findByName('m')).toMatchObject({ defaultMux: 'misao', muxRuntime: 'managed' });
  });

  it('updates both columns, also through updateWithIsolationClear', () => {
    repo.create('t', 'local');
    repo.update('t', 'local', undefined, undefined, undefined, undefined, 'system', 'misao');
    expect(repo.findByName('t')?.defaultMux).toBe('misao');
    repo.updateWithIsolationClear('t', 'local', undefined, undefined, undefined, undefined, 'managed', 'tmux');
    expect(repo.findByName('t')).toMatchObject({ defaultMux: 'tmux', muxRuntime: 'managed' });
  });

  it('throws on an unknown stored runtime, including the retired misao runtime', () => {
    db.prepare("INSERT INTO servers (name, type, mux_runtime) VALUES ('y', 'local', 'misao')").run();
    expect(() => repo.findAll()).toThrow("Invalid mux_runtime in database: 'misao'");
  });

  it('throws on an unknown stored default mux', () => {
    db.prepare("INSERT INTO servers (name, type, default_mux) VALUES ('x', 'local', 'zellij')").run();
    expect(() => repo.findAll()).toThrow("Invalid default_mux in database: 'zellij'");
  });
});
