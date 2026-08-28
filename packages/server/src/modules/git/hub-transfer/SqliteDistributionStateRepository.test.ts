import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { SqliteDistributionStateRepository } from './SqliteDistributionStateRepository';

describe('SqliteDistributionStateRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: SqliteDistributionStateRepository;

  // `findByServerAndRepo` was removed from the repository (Issue #87 Phase
  // 2: `distribution_state` is observation-only now — `FetchDistributionService`
  // decides prerequisite/already-current from the server's mirror refs, not
  // this table). These tests verify `upsert`/`deleteByServer` still write the
  // table correctly by reading it back with raw SQL instead.
  function readState(serverName: string, repositoryId: number): { lastDistributedSha: string; bundleType: string } | null {
    const row = db.prepare(
      'SELECT last_distributed_sha, bundle_type FROM distribution_state WHERE server_name = ? AND repository_id = ?',
    ).get(serverName, repositoryId) as any;
    if (!row) return null;
    return { lastDistributedSha: row.last_distributed_sha, bundleType: row.bundle_type };
  }

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
    db.exec(`
      CREATE TABLE project_repositories (id INTEGER PRIMARY KEY, project_id INTEGER);
      INSERT INTO project_repositories VALUES (1, 1);
      INSERT INTO project_repositories VALUES (2, 1);
    `);
    db.exec(`
      CREATE TABLE distribution_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_name TEXT NOT NULL,
        repository_id INTEGER NOT NULL,
        last_distributed_sha TEXT NOT NULL,
        bundle_type TEXT NOT NULL DEFAULT 'full',
        distributed_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(server_name, repository_id),
        FOREIGN KEY (repository_id) REFERENCES project_repositories(id) ON DELETE CASCADE
      )
    `);
    repo = new SqliteDistributionStateRepository(db);
  });

  it('returns null for non-existent state', () => {
    expect(readState('server-a', 1)).toBeNull();
  });

  it('inserts and retrieves state', () => {
    const sha = 'a'.repeat(40);
    repo.upsert('server-a', 1, sha, 'full');
    const state = readState('server-a', 1);
    expect(state).not.toBeNull();
    expect(state!.lastDistributedSha).toBe(sha);
    expect(state!.bundleType).toBe('full');
  });

  it('upserts (updates) existing state', () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    repo.upsert('server-a', 1, sha1, 'full');
    repo.upsert('server-a', 1, sha2, 'incremental');
    const state = readState('server-a', 1);
    expect(state!.lastDistributedSha).toBe(sha2);
    expect(state!.bundleType).toBe('incremental');
  });

  it('tracks state per server×repository independently', () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    repo.upsert('server-a', 1, sha1, 'full');
    repo.upsert('server-b', 1, sha2, 'full');
    expect(readState('server-a', 1)!.lastDistributedSha).toBe(sha1);
    expect(readState('server-b', 1)!.lastDistributedSha).toBe(sha2);
  });

  it('deleteByServer removes all state for that server', () => {
    repo.upsert('server-a', 1, 'a'.repeat(40), 'full');
    repo.upsert('server-a', 2, 'b'.repeat(40), 'full');
    repo.upsert('server-b', 1, 'c'.repeat(40), 'full');
    repo.deleteByServer('server-a');
    expect(readState('server-a', 1)).toBeNull();
    expect(readState('server-a', 2)).toBeNull();
    expect(readState('server-b', 1)).not.toBeNull();
  });
});
