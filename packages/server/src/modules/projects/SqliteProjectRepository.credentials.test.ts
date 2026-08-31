import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import BetterSqlite3 from 'better-sqlite3';
import type { SqliteDatabase } from '../../shared/db/Database';
import type { IWindowRepository } from '../windows/Window';

// Set before SecretBox's lazy `getMasterKey()` ever runs (it caches on first
// seal/open), so this file's sealed values use a known key.
process.env.AZITO_MASTER_KEY = 'a'.repeat(64);
// eslint-disable-next-line import/first
import { seal } from '../../shared/crypto/SecretBox';
import { SqliteProjectRepository } from './SqliteProjectRepository';

/** A ciphertext in SecretBox's `v1.` format sealed under a DIFFERENT master key — what a key rotation/replacement leaves behind. */
function sealWithForeignKey(plain: string): string {
  const key = Buffer.from('b'.repeat(64), 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

// Issue #87 配信状態の可視化: GET /api/projects/:id/servers reads credentials
// for every referenced repository. `findRepositoryById` throws when a stored
// credential can no longer be decrypted (master key replaced, ciphertext
// corrupted), which on a listing would 500 the entire project. This bulk
// reader must report that per row instead — and still in ONE query.

describe('SqliteProjectRepository.findRepositoryCredentialsByIds', () => {
  let db: BetterSqlite3.Database;
  let repo: SqliteProjectRepository;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, slug TEXT, description TEXT,
        repository_url TEXT, default_branch TEXT, sidekick_prompt TEXT, icon TEXT, color TEXT,
        default_unit_id INTEGER, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE project_repositories (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, url TEXT NOT NULL,
        name TEXT, provider TEXT, owner TEXT, repo_name TEXT, token TEXT
      );
      INSERT INTO projects (id, name, slug) VALUES (1, 'P', 'p');
    `);
    repo = new SqliteProjectRepository(db as unknown as SqliteDatabase, { findByProject: () => [] } as unknown as IWindowRepository);
  });

  function insertRepo(id: number, token: string | null, url = 'https://github.com/acme/widgets.git'): void {
    db.prepare('INSERT INTO project_repositories (id, project_id, url, name, provider, owner, repo_name, token) VALUES (?, 1, ?, ?, ?, ?, ?, ?)')
      .run(id, url, 'widgets', 'github', 'acme', 'widgets', token);
  }

  it('returns credentialStatus "ok" with the decrypted token for a readable credential', () => {
    insertRepo(1, seal('ghp_secret'));
    const [row] = repo.findRepositoryCredentialsByIds([1]);
    expect(row).toMatchObject({ id: 1, url: 'https://github.com/acme/widgets.git', provider: 'github', owner: 'acme', repoName: 'widgets', credentialStatus: 'ok', token: 'ghp_secret' });
  });

  it('returns credentialStatus "absent" (never a throw) when no token is stored', () => {
    insertRepo(1, null);
    expect(repo.findRepositoryCredentialsByIds([1])[0]).toMatchObject({ credentialStatus: 'absent', token: null });
  });

  it('returns credentialStatus "unreadable" for a malformed sealed value instead of throwing', () => {
    insertRepo(1, 'v1.only.three');
    expect(() => repo.findRepositoryById(1)).toThrow();
    expect(repo.findRepositoryCredentialsByIds([1])[0]).toMatchObject({ credentialStatus: 'unreadable', token: null });
  });

  it('returns credentialStatus "unreadable" for a ciphertext sealed under a different master key', () => {
    insertRepo(1, sealWithForeignKey('ghp_secret'));
    expect(() => repo.findRepositoryById(1)).toThrow();
    expect(repo.findRepositoryCredentialsByIds([1])[0]).toMatchObject({ credentialStatus: 'unreadable', token: null });
  });

  it('reports one broken credential without affecting the readable rows in the same call', () => {
    insertRepo(1, 'v1.broken');
    insertRepo(2, seal('ghp_two'));
    insertRepo(3, null);
    const byId = new Map(repo.findRepositoryCredentialsByIds([1, 2, 3]).map((r) => [r.id, r]));
    expect(byId.get(1)!.credentialStatus).toBe('unreadable');
    expect(byId.get(2)).toMatchObject({ credentialStatus: 'ok', token: 'ghp_two' });
    expect(byId.get(3)!.credentialStatus).toBe('absent');
  });

  it('reads every requested id in ONE query and silently omits ids that do not exist', () => {
    insertRepo(1, seal('a'));
    insertRepo(2, seal('b'));
    let queries = 0;
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => { queries += 1; return original(sql); }) as typeof db.prepare;
    const rows = repo.findRepositoryCredentialsByIds([1, 2, 99]);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(queries).toBe(1);
  });

  it('returns [] for an empty id list without querying at all', () => {
    let queries = 0;
    const original = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => { queries += 1; return original(sql); }) as typeof db.prepare;
    expect(repo.findRepositoryCredentialsByIds([])).toEqual([]);
    expect(queries).toBe(0);
  });
});
