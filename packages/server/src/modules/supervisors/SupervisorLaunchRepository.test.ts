import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteSupervisorLaunchRepository } from './SupervisorLaunchRepository';

// Minimal standalone DDL (not the full migration chain — supervisor_launches
// has no FK dependency on any other table, see migration 060's doc comment),
// matching the shape created by 060_authz_foundation.up().
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE supervisor_launches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      launch_id TEXT NOT NULL,
      server_name TEXT NOT NULL,
      target TEXT NOT NULL,
      task_id INTEGER,
      unit_id INTEGER,
      bootstrap_hash TEXT NOT NULL,
      session_hash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_registered_at TEXT
    )
  `);
  db.exec('CREATE UNIQUE INDEX idx_supervisor_launches_launch_id ON supervisor_launches(launch_id)');
  db.exec('CREATE UNIQUE INDEX idx_supervisor_launches_session_hash ON supervisor_launches(session_hash)');
  return db;
}

describe('SqliteSupervisorLaunchRepository', () => {
  let db: Database.Database;
  let repo: SqliteSupervisorLaunchRepository;

  beforeEach(() => {
    db = buildDb();
    repo = new SqliteSupervisorLaunchRepository(db as any);
  });

  const expectation = { serverName: 'srv-a', target: 'session:0', taskId: 5, unitId: 9 };

  it('creates a pending launch with a fresh launchId and bootstrap token', () => {
    const issued = repo.create(expectation);
    expect(issued.launchId).toBeTruthy();
    expect(issued.bootstrapToken).toBeTruthy();

    const row = repo.findByLaunchId(issued.launchId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.serverName).toBe('srv-a');
    expect(row!.target).toBe('session:0');
    expect(row!.taskId).toBe(5);
    expect(row!.unitId).toBe(9);
    expect(row!.sessionHash).toBeNull();
  });

  it('verifyBootstrap accepts the correct token while pending, rejects a wrong one', () => {
    const issued = repo.create(expectation);
    const row = repo.findByLaunchId(issued.launchId)!;
    expect(repo.verifyBootstrap(row, issued.bootstrapToken)).toBe(true);
    expect(repo.verifyBootstrap(row, 'wrong-token')).toBe(false);
  });

  it('verifyBootstrap rejects the (correct) token once the launch is no longer pending — one-shot', () => {
    const issued = repo.create(expectation);
    const activeRow = { ...repo.findByLaunchId(issued.launchId)!, status: 'active' as const };
    expect(repo.verifyBootstrap(activeRow, issued.bootstrapToken)).toBe(false);
  });

  // Fix 2 (Issue #28 third-party review, Important finding): activateWithSession
  // deliberately no longer flips status to 'active' — see its doc comment on
  // the interface. The launch stays 'pending' (bootstrap still retryable)
  // until a session-token register actually completes via touchRegistered.
  it('activateWithSession mints a session token findable by hash and leaves status pending', () => {
    const issued = repo.create(expectation);
    const sessionToken = repo.activateWithSession(issued.launchId);

    const row = repo.findByLaunchId(issued.launchId)!;
    expect(row.status).toBe('pending');
    expect(row.sessionHash).toBeTruthy();
    expect(repo.verifySession(row, sessionToken)).toBe(true);
    expect(repo.verifySession(row, 'wrong')).toBe(false);

    const bySession = repo.findBySessionHash(row.sessionHash!);
    expect(bySession?.launchId).toBe(issued.launchId);
  });

  it('touchRegistered updates last_registered_at', () => {
    const issued = repo.create(expectation);
    expect(repo.findByLaunchId(issued.launchId)!.lastRegisteredAt).toBeNull();
    repo.touchRegistered(issued.launchId);
    expect(repo.findByLaunchId(issued.launchId)!.lastRegisteredAt).toBeTruthy();
  });

  // Fix 2: this is the actual moment the bootstrap token retires — see
  // touchRegistered's and verifyBootstrap's doc comments.
  it('touchRegistered promotes a pending launch to active on its first call, and bootstrap stops verifying from then on', () => {
    const issued = repo.create(expectation);
    repo.activateWithSession(issued.launchId);
    expect(repo.findByLaunchId(issued.launchId)!.status).toBe('pending');
    expect(repo.verifyBootstrap(repo.findByLaunchId(issued.launchId)!, issued.bootstrapToken)).toBe(true);

    repo.touchRegistered(issued.launchId);

    const row = repo.findByLaunchId(issued.launchId)!;
    expect(row.status).toBe('active');
    expect(repo.verifyBootstrap(row, issued.bootstrapToken)).toBe(false);
  });

  it('touchRegistered is a no-op on status for an already-active (or replaced/expired) launch', () => {
    const issued = repo.create(expectation);
    repo.activateWithSession(issued.launchId);
    repo.touchRegistered(issued.launchId);
    expect(repo.findByLaunchId(issued.launchId)!.status).toBe('active');

    repo.touchRegistered(issued.launchId);
    expect(repo.findByLaunchId(issued.launchId)!.status).toBe('active');

    repo.markStatus(issued.launchId, 'replaced');
    repo.touchRegistered(issued.launchId);
    expect(repo.findByLaunchId(issued.launchId)!.status).toBe('replaced');
  });

  // Fix 2: reproduces the bug directly — a disconnect between the hub
  // minting the session token and the client receiving it must not strand
  // the launch. The client retries with the same (still-pending) bootstrap
  // token and gets a usable new session token.
  it('verifyBootstrap keeps succeeding for retries against the same still-pending launch after activateWithSession', () => {
    const issued = repo.create(expectation);
    repo.activateWithSession(issued.launchId); // first attempt — client never received the response
    const row = repo.findByLaunchId(issued.launchId)!;
    expect(repo.verifyBootstrap(row, issued.bootstrapToken)).toBe(true);

    const secondSessionToken = repo.activateWithSession(issued.launchId); // retry — mints a fresh session
    const row2 = repo.findByLaunchId(issued.launchId)!;
    expect(row2.status).toBe('pending');
    expect(repo.verifySession(row2, secondSessionToken)).toBe(true);
  });

  it('markStatus updates status', () => {
    const issued = repo.create(expectation);
    repo.markStatus(issued.launchId, 'replaced');
    expect(repo.findByLaunchId(issued.launchId)!.status).toBe('replaced');
  });

  it('findByLaunchId/findBySessionHash return null for unknown values', () => {
    expect(repo.findByLaunchId('nope')).toBeNull();
    expect(repo.findBySessionHash('nope')).toBeNull();
  });

  // Issue #28 third-party review, Important finding: issuing a new launch
  // for the same (serverName, target) must invalidate every prior
  // pending/active launch for that key, so its session token can never
  // authenticate a later reconnect.
  describe('create() supersedes prior pending/active launches for the same (serverName, target)', () => {
    it('marks a still-pending prior launch for the same key as replaced', () => {
      const first = repo.create(expectation);
      const second = repo.create(expectation);

      expect(repo.findByLaunchId(first.launchId)!.status).toBe('replaced');
      expect(repo.findByLaunchId(second.launchId)!.status).toBe('pending');
    });

    it('marks a still-active prior launch (already bound, with a live session) for the same key as replaced', () => {
      const first = repo.create(expectation);
      const sessionToken = repo.activateWithSession(first.launchId);
      repo.touchRegistered(first.launchId); // Fix 2: this is what promotes pending -> active now
      expect(repo.findByLaunchId(first.launchId)!.status).toBe('active');

      const second = repo.create(expectation);

      const firstRow = repo.findByLaunchId(first.launchId)!;
      expect(firstRow.status).toBe('replaced');
      // The old session token must never authenticate again once superseded
      // — this is the actual exploit the third-party review flagged (a
      // disconnected old supervisor reconnecting with its stale session
      // token after a new launch was issued for the same key).
      expect(repo.verifySession(firstRow, sessionToken)).toBe(false);
      expect(repo.findByLaunchId(second.launchId)!.status).toBe('pending');
    });

    it('does not touch a launch for a DIFFERENT (serverName, target) key', () => {
      const other = repo.create(expectation);
      repo.create({ ...expectation, target: 'session:1' });

      expect(repo.findByLaunchId(other.launchId)!.status).toBe('pending');
    });

    it('does not resurrect an already-replaced/expired launch for the key', () => {
      const first = repo.create(expectation);
      repo.markStatus(first.launchId, 'expired');
      repo.create(expectation);

      expect(repo.findByLaunchId(first.launchId)!.status).toBe('expired');
    });
  });

  describe('verifySession status gating', () => {
    it('rejects a correct session token once the launch is no longer active', () => {
      const issued = repo.create(expectation);
      const sessionToken = repo.activateWithSession(issued.launchId);
      repo.touchRegistered(issued.launchId);
      const activeRow = repo.findByLaunchId(issued.launchId)!;
      expect(activeRow.status).toBe('active');
      expect(repo.verifySession(activeRow, sessionToken)).toBe(true);

      const replacedRow = { ...activeRow, status: 'replaced' as const };
      expect(repo.verifySession(replacedRow, sessionToken)).toBe(false);
    });
  });
});
