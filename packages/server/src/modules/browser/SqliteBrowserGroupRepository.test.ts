import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteBrowserGroupRepository } from './SqliteBrowserGroupRepository';
import { openDatabase, type SqliteDatabase } from '../../shared/db/Database';

describe('SqliteBrowserGroupRepository', () => {
  let db: SqliteDatabase;
  let repo: SqliteBrowserGroupRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteBrowserGroupRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('records and finds an owner', () => {
    repo.recordOwner('srv-a', 'agent-1', 42);
    expect(repo.findOwnerTaskId('srv-a', 'agent-1')).toBe(42);
  });

  it('returns undefined for a group that was never recorded', () => {
    expect(repo.findOwnerTaskId('srv-a', 'agent-missing')).toBeUndefined();
  });

  it('remove() only deletes the targeted (server, group) row', () => {
    repo.recordOwner('srv-a', 'agent-1', 1);
    repo.recordOwner('srv-a', 'agent-2', 2);

    repo.remove('srv-a', 'agent-1');

    expect(repo.findOwnerTaskId('srv-a', 'agent-1')).toBeUndefined();
    expect(repo.findOwnerTaskId('srv-a', 'agent-2')).toBe(2);
  });

  // Issue #28 review fix 4: BrowserSessionManager.stop() calls this to
  // clear every ownership row for a server whose whole browser session just
  // stopped (destroying every group it held).
  describe('removeAllForServer', () => {
    it('deletes every row scoped to the given server, leaving other servers untouched', () => {
      repo.recordOwner('srv-a', 'agent-1', 1);
      repo.recordOwner('srv-a', 'agent-2', 2);
      repo.recordOwner('srv-b', 'agent-3', 3);

      repo.removeAllForServer('srv-a');

      expect(repo.findOwnerTaskId('srv-a', 'agent-1')).toBeUndefined();
      expect(repo.findOwnerTaskId('srv-a', 'agent-2')).toBeUndefined();
      expect(repo.findOwnerTaskId('srv-b', 'agent-3')).toBe(3);
    });

    it('is a no-op when the server has no recorded groups', () => {
      expect(() => repo.removeAllForServer('srv-never-seen')).not.toThrow();
    });
  });
});
