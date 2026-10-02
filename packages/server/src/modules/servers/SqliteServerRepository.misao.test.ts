import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { SqliteDatabase } from '../../shared/db/Database';
import { SqliteServerRepository } from './SqliteServerRepository';

describe('SqliteServerRepository (misao mux_runtime)', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE servers (
        name TEXT PRIMARY KEY, type TEXT NOT NULL, host TEXT, agent_port INTEGER, agent_token TEXT,
        agent_version TEXT, ssh_host TEXT, mux_runtime TEXT DEFAULT 'system', ssh_host_fingerprint TEXT,
        isolation_intent INTEGER DEFAULT 0, isolation_verified_at TEXT, isolation_report TEXT,
        isolation_cleanup_report TEXT, created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  });

  const repoWith = (misaoEnabled?: boolean): SqliteServerRepository =>
    new SqliteServerRepository(db as unknown as SqliteDatabase, { misaoEnabled });

  it('rejects writing misao when the flag is off', () => {
    const repo = repoWith();
    expect(() => repo.create('m', 'local', undefined, undefined, undefined, undefined, undefined, 'misao')).toThrow('AZITO_EXPERIMENTAL_MISAO');
    repo.create('t', 'local');
    expect(() => repo.update('t', 'local', undefined, undefined, undefined, undefined, 'misao')).toThrow('AZITO_EXPERIMENTAL_MISAO');
    expect(() => repo.updateWithIsolationClear('t', 'local', undefined, undefined, undefined, undefined, 'misao')).toThrow('AZITO_EXPERIMENTAL_MISAO');
    expect(repo.findByName('t')?.muxRuntime).toBe('system');
  });

  it('allows writing misao when the flag is on', () => {
    const repo = repoWith(true);
    repo.create('m', 'local', undefined, undefined, undefined, undefined, undefined, 'misao');
    expect(repo.findByName('m')?.muxRuntime).toBe('misao');
  });

  it('still reads misao rows with the flag off, so one row cannot fail findAll', () => {
    db.prepare("INSERT INTO servers (name, type, mux_runtime) VALUES ('m', 'local', 'misao'), ('t', 'local', 'system')").run();
    const repo = repoWith();
    expect(repo.findAll().map((s) => [s.name, s.muxRuntime])).toEqual(expect.arrayContaining([['m', 'misao'], ['t', 'system']]));
    expect(repo.findByName('m')?.muxRuntime).toBe('misao');
  });

  it('allows moving a misao row back to system with the flag off', () => {
    db.prepare("INSERT INTO servers (name, type, mux_runtime) VALUES ('m', 'local', 'misao')").run();
    const repo = repoWith();
    repo.update('m', 'local', undefined, undefined, undefined, undefined, 'system');
    expect(repo.findByName('m')?.muxRuntime).toBe('system');
  });

  it('still throws on an unknown stored runtime', () => {
    db.prepare("INSERT INTO servers (name, type, mux_runtime) VALUES ('x', 'local', 'herdr')").run();
    expect(() => repoWith().findAll()).toThrow("Invalid mux_runtime in database: 'herdr'");
  });

  it('lists server names by runtime', () => {
    db.prepare("INSERT INTO servers (name, type, mux_runtime) VALUES ('m', 'local', 'misao'), ('t', 'local', 'system')").run();
    expect(repoWith().listNamesByMuxRuntime('misao')).toEqual(['m']);
  });
});
