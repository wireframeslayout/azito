import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { up } from './080_server_host_profile';

function serversTable(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE servers (name TEXT PRIMARY KEY, type TEXT NOT NULL)');
  db.exec("INSERT INTO servers (name, type) VALUES ('hub', 'local'), ('old-agent', 'agent')");
  return db;
}

describe('migration: server host profile', () => {
  it('adds nullable host_platform / host_arch and leaves existing rows NULL', () => {
    const db = serversTable();
    up(db);
    const rows = db.prepare('SELECT name, host_platform, host_arch FROM servers ORDER BY name').all();
    expect(rows).toEqual([
      { name: 'hub', host_platform: null, host_arch: null },
      { name: 'old-agent', host_platform: null, host_arch: null },
    ]);
  });

  it('can run twice', () => {
    const db = serversTable();
    up(db);
    db.prepare("UPDATE servers SET host_platform = 'linux', host_arch = 'x64' WHERE name = 'old-agent'").run();
    expect(() => up(db)).not.toThrow();
    expect(db.prepare("SELECT host_platform FROM servers WHERE name = 'old-agent'").get()).toEqual({ host_platform: 'linux' });
  });
});
