import type Database from 'better-sqlite3';
import type { DistributionStateRecord, IDistributionStateRepository } from './types';

export class SqliteDistributionStateRepository implements IDistributionStateRepository {
  constructor(private db: Database.Database) {}

  upsert(serverName: string, repositoryId: number, sha: string, bundleType: 'full' | 'incremental'): void {
    this.db.prepare(`
      INSERT INTO distribution_state (server_name, repository_id, last_distributed_sha, bundle_type, distributed_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(server_name, repository_id)
      DO UPDATE SET last_distributed_sha = excluded.last_distributed_sha,
                    bundle_type = excluded.bundle_type,
                    distributed_at = excluded.distributed_at
    `).run(serverName, repositoryId, sha, bundleType);
  }

  deleteByServer(serverName: string): void {
    this.db.prepare('DELETE FROM distribution_state WHERE server_name = ?').run(serverName);
  }

  find(serverName: string, repositoryId: number): DistributionStateRecord | null {
    const row = this.db.prepare(`
      SELECT last_distributed_sha AS lastDistributedSha, bundle_type AS bundleType, distributed_at AS distributedAt
      FROM distribution_state
      WHERE server_name = ? AND repository_id = ?
    `).get(serverName, repositoryId) as DistributionStateRecord | undefined;
    return row ?? null;
  }
}
