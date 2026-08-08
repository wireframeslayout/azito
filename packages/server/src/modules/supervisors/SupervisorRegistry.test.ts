import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { SupervisorRegistry } from './SupervisorRegistry';
import { SUPERVISOR_PROTOCOL_VERSION, type RegisterMessage } from './protocol';
import { SqliteSupervisorLaunchRepository } from './SupervisorLaunchRepository';
import type { AuditLogService } from '../../shared/audit/AuditLogService';

/** Minimal ws.WebSocket stand-in: EventEmitter + the handful of members the registry touches. */
class MockSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  readonly OPEN = 1;
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  terminated = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = ''): void {
    this.closed = { code, reason };
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }

  ping(): void {
    // no-op — tests trigger 'pong' manually
  }
}

function asSocket(mock: MockSocket): WebSocket {
  return mock as unknown as WebSocket;
}

function registerMessage(overrides: Partial<RegisterMessage> = {}): RegisterMessage {
  return {
    type: 'register',
    protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
    serverName: 'local',
    target: 'test:0.1',
    taskId: 42,
    unitId: 7,
    pid: 1234,
    childCommand: 'bash',
    // Matches current HubClient behavior (always reports readiness). Tests covering the
    // pre-readiness-signal/legacy-supervisor compatibility path override this explicitly.
    reportsReady: true,
    ...overrides,
  };
}

describe('SupervisorRegistry', () => {
  let registry: SupervisorRegistry;

  beforeEach(() => {
    registry = new SupervisorRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a supervisor and replies with a registered message', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    expect(socket.sent).toEqual([{ type: 'registered' }]);
    expect(registry.isConnected('local', 'test:0.1')).toBe(true);
  });

  it('rejects registration on protocol version mismatch and closes with code 4000', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage({ protocolVersion: 999 }));

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toEqual({ code: 4000, reason: 'protocol version mismatch' });
    expect(registry.isConnected('local', 'test:0.1')).toBe(false);
  });

  it('replaces an existing registration under the same key, closing the old socket', () => {
    const oldSocket = new MockSocket();
    registry.register(asSocket(oldSocket), registerMessage());

    const newSocket = new MockSocket();
    registry.register(asSocket(newSocket), registerMessage({ pid: 5678 }));

    expect(oldSocket.closed).toEqual({ code: 1000, reason: 'replaced by new registration' });
    expect(newSocket.sent).toEqual([{ type: 'registered' }]);

    const snapshot = registry.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].pid).toBe(5678);
  });

  it('resolves sendCommand when a matching ack (ok:true) arrives', async () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    const promise = registry.sendCommand('local', 'test:0.1', { type: 'interrupt' });
    expect(socket.sent).toHaveLength(2); // registered + interrupt command
    const sentCmd = socket.sent[1] as { id: string; type: string };
    expect(sentCmd.type).toBe('interrupt');

    registry.handleMessage(asSocket(socket), { type: 'ack', id: sentCmd.id, ok: true });
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects sendCommand when ack arrives with ok:false', async () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    const promise = registry.sendCommand('local', 'test:0.1', { type: 'interrupt' });
    const sentCmd = socket.sent[1] as { id: string };

    registry.handleMessage(asSocket(socket), { type: 'ack', id: sentCmd.id, ok: false, error: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('rejects sendCommand after a 10s ack timeout', async () => {
    vi.useFakeTimers();
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    const promise = registry.sendCommand('local', 'test:0.1', { type: 'interrupt' });
    const assertion = expect(promise).rejects.toThrow('ack timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('throws when sending a command to an unconnected target', async () => {
    await expect(registry.sendCommand('local', 'nope:0', { type: 'interrupt' })).rejects.toThrow(
      'supervisor not connected',
    );
  });

  it('rejects all pending acks when the socket closes', async () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    const promise = registry.sendCommand('local', 'test:0.1', { type: 'interrupt' });
    registry.handleSocketClosed(asSocket(socket));

    await expect(promise).rejects.toThrow('supervisor disconnected');
    expect(registry.isConnected('local', 'test:0.1')).toBe(false);
  });

  it('emits a disconnected event when the socket closes', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    const onDisconnected = vi.fn();
    registry.on('disconnected', onDisconnected);
    registry.handleSocketClosed(asSocket(socket));

    expect(onDisconnected).toHaveBeenCalledWith({ serverName: 'local', target: 'test:0.1', bound: true });
  });

  it('does not emit disconnected for a stale close from an already-replaced socket', () => {
    const oldSocket = new MockSocket();
    registry.register(asSocket(oldSocket), registerMessage());
    registry.register(asSocket(new MockSocket()), registerMessage({ pid: 5678 }));

    const onDisconnected = vi.fn();
    registry.on('disconnected', onDisconnected);
    registry.handleSocketClosed(asSocket(oldSocket));

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('emits activity events', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    const onActivity = vi.fn();
    registry.on('activity', onActivity);
    registry.handleMessage(asSocket(socket), { type: 'activity', state: 'active', bytesInWindow: 12, ts: Date.now() });

    expect(onActivity).toHaveBeenCalledWith({
      serverName: 'local',
      target: 'test:0.1',
      taskId: 42,
      unitId: 7,
      state: 'active',
      status: undefined,
      childCommand: 'bash',
      bound: true,
    });
  });

  it('emits child_exit events and removes the entry', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    const onChildExit = vi.fn();
    registry.on('child_exit', onChildExit);
    registry.handleMessage(asSocket(socket), { type: 'child_exit', exitCode: 0, signal: null, ts: Date.now() });

    expect(onChildExit).toHaveBeenCalledWith({
      serverName: 'local',
      target: 'test:0.1',
      taskId: 42,
      exitCode: 0,
      signal: null,
      bound: true,
    });
    expect(registry.isConnected('local', 'test:0.1')).toBe(false);
  });

  it('marks hasRecentChildExit true after child_exit', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(false);
    registry.handleMessage(asSocket(socket), { type: 'child_exit', exitCode: 0, signal: null, ts: Date.now() });
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(true);
  });

  it('clears hasRecentChildExit once a new connection registers for the same key', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());
    registry.handleMessage(asSocket(socket), { type: 'child_exit', exitCode: 0, signal: null, ts: Date.now() });
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(true);

    registry.register(asSocket(new MockSocket()), registerMessage());
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(false);
  });

  it('hasRecentChildExit is false for a key that never registered', () => {
    expect(registry.hasRecentChildExit('local', 'never-registered:0')).toBe(false);
  });

  it('expires hasRecentChildExit after EXITED_KEY_TTL_MS and removes the entry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());
    registry.handleMessage(asSocket(socket), { type: 'child_exit', exitCode: 0, signal: null, ts: Date.now() });
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(true);

    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    vi.setSystemTime(1_000_000 + TWENTY_FOUR_HOURS_MS - 1);
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(true);

    vi.setSystemTime(1_000_000 + TWENTY_FOUR_HOURS_MS + 1);
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(false);
    // Expiry deletes the entry outright — re-checking immediately after should not require
    // recomputing the same "expired" branch (not directly observable from the outside, but a
    // second call is a cheap way to confirm the first call didn't throw/leave bad state).
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(false);
  });

  it('clearExitMarker removes a recorded child_exit marker', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());
    registry.handleMessage(asSocket(socket), { type: 'child_exit', exitCode: 0, signal: null, ts: Date.now() });
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(true);

    registry.clearExitMarker('local', 'test:0.1');
    expect(registry.hasRecentChildExit('local', 'test:0.1')).toBe(false);
  });

  it('clearExitMarker is a no-op for a key with no marker', () => {
    expect(() => registry.clearExitMarker('local', 'never-marked:0')).not.toThrow();
    expect(registry.hasRecentChildExit('local', 'never-marked:0')).toBe(false);
  });

  it('registers with ready:false in the snapshot', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage({ reportsReady: true }));

    expect(registry.snapshot()[0].ready).toBe(false);
  });

  it('registers with ready:true immediately for a supervisor that omits reportsReady (pre-readiness-signal compatibility)', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage({ reportsReady: undefined }));

    expect(registry.snapshot()[0].ready).toBe(true);
  });

  it('sets ready:true on the snapshot and emits a ready event on the ready message', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage({ reportsReady: true }));

    const onReady = vi.fn();
    registry.on('ready', onReady);
    registry.handleMessage(asSocket(socket), { type: 'ready', ts: Date.now() });

    expect(registry.snapshot()[0].ready).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({
      serverName: 'local',
      target: 'test:0.1',
      taskId: 42,
      unitId: 7,
    });
  });

  it('does not re-emit ready for a duplicate ready message on the same connection', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage({ reportsReady: true }));

    const onReady = vi.fn();
    registry.on('ready', onReady);
    registry.handleMessage(asSocket(socket), { type: 'ready', ts: Date.now() });
    registry.handleMessage(asSocket(socket), { type: 'ready', ts: Date.now() });

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(registry.snapshot()[0].ready).toBe(true);
  });

  it('ignores malformed/unknown message types without throwing', () => {
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    expect(() => registry.handleMessage(asSocket(socket), { type: 'unknown_type' } as never)).not.toThrow();
  });

  it('updates lastHeartbeatAt on heartbeat', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());
    const before = registry.snapshot()[0].lastHeartbeatAt;

    vi.setSystemTime(1_005_000);
    registry.handleMessage(asSocket(socket), { type: 'heartbeat', ts: Date.now() });

    const after = registry.snapshot()[0].lastHeartbeatAt;
    expect(after).toBeGreaterThan(before);
  });

  it('terminates the socket after two consecutive missed pongs', () => {
    vi.useFakeTimers();
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    vi.advanceTimersByTime(15_000); // 1st ping tick — missedPongs 0 -> 1
    expect(socket.terminated).toBe(false);

    vi.advanceTimersByTime(15_000); // 2nd ping tick with no pong in between -> terminate
    expect(socket.terminated).toBe(true);
  });

  it('does not terminate the socket when a pong is received between pings', () => {
    vi.useFakeTimers();
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage());

    vi.advanceTimersByTime(15_000);
    socket.emit('pong');
    vi.advanceTimersByTime(15_000);

    expect(socket.terminated).toBe(false);
  });
});

describe('SupervisorRegistry — launch binding (Issue #28 Phase C, design v3 §8)', () => {
  let db: Database.Database;
  let launchRepo: SqliteSupervisorLaunchRepository;
  let auditLogService: AuditLogService;
  let auditRecord: ReturnType<typeof vi.fn>;

  function buildDb(): Database.Database {
    const d = new Database(':memory:');
    d.exec(`
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
    d.exec('CREATE UNIQUE INDEX idx_supervisor_launches_launch_id ON supervisor_launches(launch_id)');
    d.exec('CREATE UNIQUE INDEX idx_supervisor_launches_session_hash ON supervisor_launches(session_hash)');
    return d;
  }

  beforeEach(() => {
    db = buildDb();
    launchRepo = new SqliteSupervisorLaunchRepository(db as any);
    auditRecord = vi.fn();
    auditLogService = { record: auditRecord } as unknown as AuditLogService;
  });

  afterEach(() => {
    db.close();
  });

  function registerWith(overrides: Partial<RegisterMessage>): RegisterMessage {
    return registerMessage(overrides);
  }

  it('scopedAuthEnabled=false (compat): a launchId-less register is bound, no DB/audit interaction', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, false);
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerWith({}));

    expect(registry.snapshot()[0].bound).toBe(true);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('scopedAuthEnabled=true: a launchId-less register is accepted but marked unbound, and audited', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerWith({}));

    expect(socket.closed).toBeNull();
    expect(registry.snapshot()[0].bound).toBe(false);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.unbound' }));
  });

  it('accepts a bootstrapToken matching an issued launch, marks bound, and returns a sessionToken', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issued = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;
    const socket = new MockSocket();

    registry.register(asSocket(socket), registerWith({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));

    expect(socket.closed).toBeNull();
    expect(registry.snapshot()[0].bound).toBe(true);
    const registered = socket.sent[0] as { type: string; sessionToken?: string };
    expect(registered.type).toBe('registered');
    expect(registered.sessionToken).toBeTruthy();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.bound' }));
  });

  it('rejects a bootstrapToken reused a second time (one-shot)', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issued = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const first = new MockSocket();
    registry.register(asSocket(first), registerWith({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    expect(first.closed).toBeNull();

    const replay = new MockSocket();
    registry.register(asSocket(replay), registerWith({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    expect(replay.closed?.code).toBe(4001);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.bootstrap_rejected' }));
  });

  it('rejects a register whose claimed identity does not match the issued launch', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issued = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;
    const socket = new MockSocket();

    registry.register(
      asSocket(socket),
      registerWith({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken, taskId: 999 }),
    );

    expect(socket.closed?.code).toBe(4001);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.mismatch' }));
  });

  it('accepts a reconnect via the returned sessionToken after the bootstrap round', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issued = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const first = new MockSocket();
    registry.register(asSocket(first), registerWith({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    const sessionToken = (first.sent[0] as { sessionToken: string }).sessionToken;
    first.close();

    const reconnect = new MockSocket();
    registry.register(asSocket(reconnect), registerWith({ launchId: issued.launchId, sessionToken }));

    expect(reconnect.closed).toBeNull();
    expect(registry.snapshot()[0].bound).toBe(true);
  });

  it('rejects a reconnect with a wrong sessionToken', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issued = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;
    const first = new MockSocket();
    registry.register(asSocket(first), registerWith({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    first.close();

    const reconnect = new MockSocket();
    registry.register(asSocket(reconnect), registerWith({ launchId: issued.launchId, sessionToken: 'wrong' }));

    expect(reconnect.closed?.code).toBe(4001);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.session_rejected' }));
  });

  it('rejects registration for an unknown launchId', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerWith({ launchId: 'nope', bootstrapToken: 'anything' }));

    expect(socket.closed?.code).toBe(4001);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.unknown' }));
  });

  it('rejects a same-key registration from a DIFFERENT launchId while a bound connection is live (no eviction)', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issuedA = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const first = new MockSocket();
    registry.register(asSocket(first), registerWith({ launchId: issuedA.launchId, bootstrapToken: issuedA.bootstrapToken }));
    expect(first.closed).toBeNull();

    // The in-memory eviction guard (register()'s EXCEPTION branch) fires
    // before any DB lookup for the intruder's launchId — a forged/unrelated
    // launchId is enough to exercise it (a REAL second `issueLaunch()` for
    // this same key would supersede issuedA in the DB per create()'s own
    // fix — see the "supersedes prior launches" describe block below — so
    // this guard is specifically about protecting a still-live BOUND
    // connection from being evicted by a differently-identified register,
    // independent of whether that other identity is itself valid).
    const intruder = new MockSocket();
    registry.register(asSocket(intruder), registerWith({ launchId: 'unrelated-forged-launch-id', bootstrapToken: 'irrelevant' }));

    expect(intruder.closed?.code).toBe(4009);
    // The original connection must still be live and untouched.
    expect(first.closed).toBeNull();
    expect(registry.snapshot()).toHaveLength(1);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.replace_rejected' }));
  });

  // Issue #28 third-party review, Important finding: issuing a fresh launch
  // for a key that already had one outstanding must invalidate the old one
  // — the actual exploit was a disconnected old supervisor reconnecting with
  // its still-hash-valid session token after a NEW launch (and NEW window
  // generation) had already been issued for the same key.
  describe('SupervisorRegistry — re-launch supersedes the prior launch for the same key', () => {
    it('rejects a reconnect with the OLD session token once a new launch has been issued for the same key', () => {
      const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
      const issuedA = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

      const first = new MockSocket();
      registry.register(asSocket(first), registerWith({ launchId: issuedA.launchId, bootstrapToken: issuedA.bootstrapToken }));
      const sessionToken = (first.sent[0] as { sessionToken: string }).sessionToken;
      // The old supervisor's connection drops (e.g. its tmux window was
      // killed as part of a fresh execute()/respawn() for this task) —
      // nothing left in `connections` for this key to protect it via the
      // in-memory eviction guard.
      first.close();
      registry.handleSocketClosed(asSocket(first));

      // A fresh execute()/respawn() issues a NEW launch for the SAME key —
      // this must supersede issuedA (SqliteSupervisorLaunchRepository.create()).
      registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 });

      // The old supervisor process (unaware anything changed) reconnects
      // with its still-cryptographically-valid old session token.
      const reconnect = new MockSocket();
      registry.register(asSocket(reconnect), registerWith({ launchId: issuedA.launchId, sessionToken }));

      expect(reconnect.closed?.code).toBe(4001);
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.session_rejected' }));
      expect(registry.snapshot()).toHaveLength(0);
    });

    it('rejects a bootstrap-token registration for a launch that has since been superseded', () => {
      const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
      const issuedA = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;
      // Superseded before issuedA ever registers at all.
      registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 });

      const socket = new MockSocket();
      registry.register(asSocket(socket), registerWith({ launchId: issuedA.launchId, bootstrapToken: issuedA.bootstrapToken }));

      expect(socket.closed?.code).toBe(4001);
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.bootstrap_rejected' }));
    });
  });

  // Issue #28 Phase C review, Important finding: the eviction guard used to
  // reject a DIFFERENT-launchId registration purely on launchId mismatch,
  // before checking whether that new registration was itself a legitimately
  // authenticated (and DB-current) replacement launch. That meant a genuine
  // re-launch for the same key (new launch issued, superseding the old one)
  // was permanently blocked as long as the OLD supervisor's WebSocket
  // happened to still be connected when the new one tried to register —
  // exactly the case a hub hasn't yet observed the old process's exit.
  it('an authenticated NEW launch replaces a still-connected OLD bound connection (no dead-key stranding)', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issuedA = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const oldSocket = new MockSocket();
    registry.register(asSocket(oldSocket), registerWith({ launchId: issuedA.launchId, bootstrapToken: issuedA.bootstrapToken }));
    expect(oldSocket.closed).toBeNull();

    // A fresh execute()/respawn() issues a NEW launch for the SAME key while
    // the old connection is still live in `connections` (hub hasn't seen it
    // disconnect yet) — this supersedes issuedA in the DB.
    const issuedB = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const newSocket = new MockSocket();
    registry.register(asSocket(newSocket), registerWith({ launchId: issuedB.launchId, bootstrapToken: issuedB.bootstrapToken }));

    expect(newSocket.closed).toBeNull();
    expect(oldSocket.closed).toEqual({ code: 1000, reason: 'replaced by new registration' });
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.snapshot()[0].bound).toBe(true);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'supervisor_launch.bound', detail: expect.objectContaining({ launchId: issuedB.launchId }) }),
    );
    expect(auditRecord).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.replace_rejected' }));
  });

  it('an UNAUTHENTICATED replacement attempt (bad token) is still rejected, leaving the bound connection untouched', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issuedA = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const oldSocket = new MockSocket();
    registry.register(asSocket(oldSocket), registerWith({ launchId: issuedA.launchId, bootstrapToken: issuedA.bootstrapToken }));

    const issuedB = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const intruder = new MockSocket();
    registry.register(asSocket(intruder), registerWith({ launchId: issuedB.launchId, bootstrapToken: 'wrong-token' }));

    expect(intruder.closed?.code).toBe(4009);
    expect(oldSocket.closed).toBeNull();
    expect(registry.snapshot()).toHaveLength(1);
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ event: 'supervisor_launch.replace_rejected' }));
  });

  it('a same-launchId reconnection still replaces the previous connection (normal reconnect)', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const issued = registry.issueLaunch({ serverName: 'local', target: 'test:0.1', taskId: 42, unitId: 7 })!;

    const first = new MockSocket();
    registry.register(asSocket(first), registerWith({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    const sessionToken = (first.sent[0] as { sessionToken: string }).sessionToken;

    const second = new MockSocket();
    registry.register(asSocket(second), registerWith({ launchId: issued.launchId, sessionToken }));

    expect(second.closed).toBeNull();
    expect(first.closed).toEqual({ code: 1000, reason: 'replaced by new registration' });
  });

  it('gates AgentActivityMonitor/turn-progress bridging via the emitted bound flag', () => {
    const registry = new SupervisorRegistry(launchRepo, auditLogService, true);
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerWith({}));

    const onActivity = vi.fn();
    registry.on('activity', onActivity);
    registry.handleMessage(asSocket(socket), { type: 'activity', state: 'active', bytesInWindow: 12, ts: Date.now() });

    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ bound: false }));
  });
});
