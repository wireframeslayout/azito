import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../db/Database';
import { SqliteAuditLogRepository } from './AuditLogRepository';

describe('SqliteAuditLogRepository', () => {
  let db: SqliteDatabase;
  let repo: SqliteAuditLogRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteAuditLogRepository(db);
  });

  it('listRecent() returns rows newest-first, capped at limit', () => {
    repo.record({ actorClass: 'operator', event: 'e1', detail: { n: 1 } });
    repo.record({ actorClass: 'task', actorId: 5, event: 'e2', detail: { n: 2 } });
    repo.record({ actorClass: 'runtime', event: 'e3' });

    const rows = repo.listRecent(2);
    expect(rows).toHaveLength(2);
    expect(rows[0].event).toBe('e3');
    expect(rows[1].event).toBe('e2');
  });

  it('round-trips detail as a parsed object, and actorId as null when absent', () => {
    repo.record({ actorClass: 'task', actorId: 5, event: 'task_token.issued', detail: { taskId: 5, tokenId: 1 } });
    const [row] = repo.listRecent(1);
    expect(row.actorClass).toBe('task');
    expect(row.actorId).toBe(5);
    expect(row.detail).toEqual({ taskId: 5, tokenId: 1 });
  });

  it('detail is null when the entry carried no detail', () => {
    repo.record({ actorClass: 'operator', event: 'no_detail' });
    const [row] = repo.listRecent(1);
    expect(row.detail).toBeNull();
  });

  it('actorId is null (not undefined/omitted) when the entry carried none', () => {
    repo.record({ actorClass: 'operator', event: 'no_actor_id' });
    const [row] = repo.listRecent(1);
    expect(row.actorId).toBeNull();
  });
});
