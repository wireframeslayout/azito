import { describe, it, expect, beforeEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { SqliteDistributionStateRepository } from './SqliteDistributionStateRepository';

describe('SqliteDistributionStateRepository', () => {
  let db: BetterSqlite3.Database;
  let repo: SqliteDistributionStateRepository;

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
    expect(repo.findByServerAndRepo('server-a', 1)).toBeNull();
  });

  it('inserts and retrieves state', () => {
    const sha = 'a'.repeat(40);
    repo.upsert('server-a', 1, sha, 'full');
    const state = repo.findByServerAndRepo('server-a', 1);
    expect(state).not.toBeNull();
    expect(state!.lastDistributedSha).toBe(sha);
    expect(state!.bundleType).toBe('full');
    expect(state!.serverName).toBe('server-a');
    expect(state!.repositoryId).toBe(1);
  });

  it('upserts (updates) existing state', () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    repo.upsert('server-a', 1, sha1, 'full');
    repo.upsert('server-a', 1, sha2, 'incremental');
    const state = repo.findByServerAndRepo('server-a', 1);
    expect(state!.lastDistributedSha).toBe(sha2);
    expect(state!.bundleType).toBe('incremental');
  });

  it('tracks state per server×repository independently', () => {
    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    repo.upsert('server-a', 1, sha1, 'full');
    repo.upsert('server-b', 1, sha2, 'full');
    expect(repo.findByServerAndRepo('server-a', 1)!.lastDistributedSha).toBe(sha1);
    expect(repo.findByServerAndRepo('server-b', 1)!.lastDistributedSha).toBe(sha2);
  });

  it('deleteByServer removes all state for that server', () => {
    repo.upsert('server-a', 1, 'a'.repeat(40), 'full');
    repo.upsert('server-a', 2, 'b'.repeat(40), 'full');
    repo.upsert('server-b', 1, 'c'.repeat(40), 'full');
    repo.deleteByServer('server-a');
    expect(repo.findByServerAndRepo('server-a', 1)).toBeNull();
    expect(repo.findByServerAndRepo('server-a', 2)).toBeNull();
    expect(repo.findByServerAndRepo('server-b', 1)).not.toBeNull();
  });
});
