import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type { SqliteDatabase } from '../../shared/db/Database';
import { SqliteServerRepository } from './SqliteServerRepository';

// Issue #87 配信状態の可視化 (third-party review follow-up): read-only
// listings must not be able to fail because SOME server's `agent_token`
// cannot be decrypted. `findAll()` maps every row through `toEntity()`, which
// calls `SecretBox.open()`; `findMetaByNames()` reads only the non-secret
// columns and must never reach it.

describe('SqliteServerRepository.findMetaByNames', () => {
  let db: BetterSqlite3.Database;
  let repo: SqliteServerRepository;

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
    repo = new SqliteServerRepository(db as unknown as SqliteDatabase);
  });

  function insertServer(name: string, opts: { type?: string; token?: string | null; isolationIntent?: boolean } = {}): void {
    db.prepare('INSERT INTO servers (name, type, agent_token, isolation_intent) VALUES (?, ?, ?, ?)')
      .run(name, opts.type ?? 'agent', opts.token ?? null, opts.isolationIntent ? 1 : 0);
  }

  it('returns name/type/isolationIntent for the requested servers', () => {
    insertServer('iso-1', { isolationIntent: true });
    insertServer('plain', { type: 'local' });
    const rows = repo.findMetaByNames(['iso-1', 'plain']);
    expect(rows).toContainEqual({ name: 'iso-1', type: 'agent', isolationIntent: true });
    expect(rows).toContainEqual({ name: 'plain', type: 'local', isolationIntent: false });
  });

  it('does NOT decrypt agent_token — a credential findAll() chokes on is read without error', () => {
    insertServer('broken', { token: 'v1.only.three', isolationIntent: true });
    // Proof the credential really is undecryptable on the eager path.
    expect(() => repo.findAll()).toThrow();
    expect(repo.findMetaByNames(['broken'])).toEqual([{ name: 'broken', type: 'agent', isolationIntent: true }]);
  });

  it('never selects the agent_token column at all', () => {
    insertServer('iso-1');
    const prepared: string[] = [];
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => { prepared.push(sql); return original(sql); }) as typeof db.prepare;
    repo.findMetaByNames(['iso-1']);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).not.toContain('agent_token');
    expect(prepared[0]).not.toContain('*');
  });

  it('reads every requested name in ONE query and omits names that do not resolve', () => {
    insertServer('a');
    insertServer('b');
    let queries = 0;
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => { queries += 1; return original(sql); }) as typeof db.prepare;
    expect(repo.findMetaByNames(['a', 'b', 'missing']).map((s) => s.name).sort()).toEqual(['a', 'b']);
    expect(queries).toBe(1);
  });

  it('applies the same server-type filter findAll() does', () => {
    insertServer('legacy-ssh', { type: 'ssh' });
    expect(repo.findMetaByNames(['legacy-ssh'])).toEqual([]);
    expect(repo.findAll().map((s) => s.name)).not.toContain('legacy-ssh');
  });

  it('returns [] for an empty name list without querying at all', () => {
    let queries = 0;
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => { queries += 1; return original(sql); }) as typeof db.prepare;
    expect(repo.findMetaByNames([])).toEqual([]);
    expect(queries).toBe(0);
  });
});
