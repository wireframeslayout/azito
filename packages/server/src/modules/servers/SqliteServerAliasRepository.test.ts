import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../shared/db/Database';
import { SqliteServerRepository } from './SqliteServerRepository';
import { SqliteServerAliasRepository } from './SqliteServerAliasRepository';

// TODO(#313): remove with the server_aliases compatibility.
describe('SqliteServerAliasRepository', () => {
  let db: SqliteDatabase;
  let aliases: SqliteServerAliasRepository;
  let servers: SqliteServerRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    aliases = new SqliteServerAliasRepository(db);
    servers = new SqliteServerRepository(db);
    db.prepare("INSERT INTO server_aliases (old_name, new_name) VALUES ('local-misao', 'local')").run();
  });

  it('resolves an old name to the merged server and leaves other names alone', () => {
    expect(aliases.resolve('local-misao')).toBe('local');
    expect(aliases.resolve('local')).toBe('local');
    expect(aliases.resolve('other')).toBe('other');
  });

  it('lists the aliases', () => {
    expect(aliases.findAll()).toEqual([{ oldName: 'local-misao', newName: 'local' }]);
  });

  it('drops an alias when a new server takes the old name', () => {
    servers.create('local-misao', 'local');
    expect(aliases.resolve('local-misao')).toBe('local-misao');
    expect(aliases.findAll()).toEqual([]);
  });

  it('drops the aliases of a deleted server', () => {
    servers.delete('local');
    expect(aliases.findAll()).toEqual([]);
  });
});
