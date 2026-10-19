import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { SqliteDatabase } from '../../shared/db/Database';
import { SqliteServerRepository } from './SqliteServerRepository';

describe('SqliteServerRepository (host profile)', () => {
  let db: BetterSqlite3.Database;
  let repo: SqliteServerRepository;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE servers (
        name TEXT PRIMARY KEY, type TEXT NOT NULL, host TEXT, agent_port INTEGER, agent_token TEXT,
        agent_version TEXT, ssh_host TEXT, mux_runtime TEXT NOT NULL DEFAULT 'system', default_mux TEXT NOT NULL DEFAULT 'tmux',
        ssh_host_fingerprint TEXT, host_platform TEXT, host_arch TEXT,
        isolation_intent INTEGER DEFAULT 0, isolation_verified_at TEXT, isolation_report TEXT,
        isolation_cleanup_report TEXT, created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    repo = new SqliteServerRepository(db as unknown as SqliteDatabase);
  });

  it('reads a server with no recorded host as null (not Linux)', () => {
    repo.create('old', 'agent', '100.64.0.2', 3002, undefined);
    expect(repo.findByName('old')?.hostProfile).toBeNull();
  });

  it('stores the host profile given at creation, apart from the connection address', () => {
    repo.create('w', 'agent', '100.64.0.2', 3002, undefined, 'v1', undefined, undefined, undefined, { platform: 'darwin', arch: 'arm64' });
    expect(repo.findByName('w')).toMatchObject({ host: '100.64.0.2', hostProfile: { platform: 'darwin', arch: 'arm64' } });
  });

  it('records and clears the profile', () => {
    repo.create('a', 'agent', '100.64.0.2', 3002, undefined);
    repo.updateHostProfile('a', { platform: 'linux', arch: 'x64' });
    expect(repo.findByName('a')?.hostProfile).toEqual({ platform: 'linux', arch: 'x64' });
    repo.updateHostProfile('a', null);
    expect(repo.findByName('a')?.hostProfile).toBeNull();
  });

  it('keeps the profile when the connection settings are updated', () => {
    repo.create('a', 'agent', '100.64.0.2', 3002, undefined, undefined, undefined, undefined, undefined, { platform: 'linux', arch: 'x64' });
    repo.update('a', 'agent', '100.64.0.2', 3002, undefined, undefined, 'managed', 'tmux');
    expect(repo.findByName('a')?.hostProfile).toEqual({ platform: 'linux', arch: 'x64' });
  });

  it('never uses what a local row holds: the hub derives its own host', () => {
    db.prepare("INSERT INTO servers (name, type, host_platform, host_arch) VALUES ('local', 'local', 'win32', 'x64')").run();
    expect(repo.findByName('local')?.hostProfile).toBeNull();
  });

  it('throws on a stored host the hub does not know, and on half a profile', () => {
    db.prepare("INSERT INTO servers (name, type, host_platform, host_arch) VALUES ('bsd', 'agent', 'freebsd', 'x64')").run();
    expect(() => repo.findByName('bsd')).toThrowError(expect.objectContaining({ code: 'unsupported_host' }));
    db.prepare("INSERT INTO servers (name, type, host_platform, host_arch) VALUES ('half', 'agent', 'linux', NULL)").run();
    expect(() => repo.findByName('half')).toThrow(/Both must be set or both NULL/);
  });
});
