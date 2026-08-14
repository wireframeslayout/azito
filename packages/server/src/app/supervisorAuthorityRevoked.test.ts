import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { SupervisorRegistry, type SupervisorActivityEvent, type SupervisorChildExitEvent, type SupervisorDisconnectedEvent, type SupervisorAuthorityRevokedEvent } from '../modules/supervisors/SupervisorRegistry';
import { SUPERVISOR_PROTOCOL_VERSION, type RegisterMessage } from '../modules/supervisors/protocol';
import { SqliteSupervisorLaunchRepository } from '../modules/supervisors/SupervisorLaunchRepository';
import type { AuditLogService } from '../shared/audit/AuditLogService';
import { AgentActivityMonitor } from '../modules/operations/AgentActivityMonitor';
import type { ExecuteTaskUseCase } from '../modules/tasks/execution/ExecuteTaskUseCase';
import type { IWindowRepository, Window } from '../modules/windows/Window';
import type { TmuxClient } from '../modules/tmux/TmuxClient';
import type { IServerRepository, ServerConfig } from '../modules/servers/Server';
import type { NotificationBus } from '../modules/notifications/NotificationBus';

/**
 * Issue #28 third-party review (Important, fix 1): reproduces the exact
 * wiring buildServer.ts installs between SupervisorRegistry and
 * AgentActivityMonitor (see buildServer.ts's "Supervisor activity bridges"
 * section) — without pulling in the rest of the Fastify wiring — so the
 * bound→unbound downgrade path can be exercised end to end: a stale Tier 0
 * verdict must be cleared the moment a connection loses its authority, and
 * that connection's own subsequent (now-unbound) activity must not revive it.
 */

class MockSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
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
    target: 'azito:agent-1.1',
    taskId: 42,
    unitId: 7,
    pid: 1234,
    childCommand: 'claude',
    reportsReady: true,
    ...overrides,
  };
}

function buildLaunchDb(): Database.Database {
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

describe('SupervisorRegistry <-> AgentActivityMonitor bridge (Issue #28 third-party review, Important)', () => {
  let db: Database.Database;
  let launchRepo: SqliteSupervisorLaunchRepository;
  let auditLogService: AuditLogService;
  let registry: SupervisorRegistry;
  let monitor: AgentActivityMonitor;
  let findAll: ReturnType<typeof vi.fn>;
  let listSessions: ReturnType<typeof vi.fn>;
  let capturePane: ReturnType<typeof vi.fn>;
  let findByName: ReturnType<typeof vi.fn>;
  let getRunning: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = buildLaunchDb();
    launchRepo = new SqliteSupervisorLaunchRepository(db as any);
    auditLogService = { record: vi.fn() } as unknown as AuditLogService;
    registry = new SupervisorRegistry(launchRepo, auditLogService, true);

    getRunning = vi.fn().mockReturnValue({});
    findAll = vi.fn<() => Window[]>().mockReturnValue([]);
    listSessions = vi.fn().mockResolvedValue([]);
    capturePane = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    findByName = vi.fn().mockReturnValue({ name: 'local', type: 'local' } as ServerConfig);
    emit = vi.fn();

    monitor = new AgentActivityMonitor(
      { getRunning } as unknown as ExecuteTaskUseCase,
      { findAll } as unknown as IWindowRepository,
      { listSessions, capturePane } as unknown as TmuxClient,
      { findByName } as unknown as IServerRepository,
      { emit } as unknown as NotificationBus,
    );

    // Exactly the subscription block buildServer.ts installs (post-fix).
    registry.on('activity', (event: SupervisorActivityEvent) => {
      if (!event.bound) return;
      const label = event.childCommand.trim().split(/\s+/)[0] || null;
      monitor.recordSupervisorSignal(event.serverName, event.target, event.state, event.taskId, label, event.status);
    });
    registry.on('child_exit', (event: SupervisorChildExitEvent) => {
      monitor.recordSupervisorSignal(event.serverName, event.target, 'exited');
    });
    registry.on('disconnected', (event: SupervisorDisconnectedEvent) => {
      monitor.recordSupervisorSignal(event.serverName, event.target, 'exited');
    });
    registry.on('authority_revoked', (event: SupervisorAuthorityRevokedEvent) => {
      monitor.recordSupervisorSignal(event.serverName, event.target, 'exited');
    });
  });

  it('a downgrade clears a previously-established Tier 0 verdict, and the downgraded connection cannot re-establish it', async () => {
    const issued = registry.issueLaunch({ serverName: 'local', target: 'azito:agent-1.1', taskId: 42, unitId: 7 })!;
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    expect(registry.snapshot()[0].bound).toBe(true);

    // Bound activity establishes Tier 0 for this key.
    registry.handleMessage(asSocket(socket), { type: 'activity', state: 'active', bytesInWindow: 12, ts: Date.now() });
    await monitor.tick();

    let diag = monitor.diagnostics().find((d) => d.target === 'azito:agent-1');
    expect(diag?.decidedBy).toBe('tier0_supervisor');
    expect(diag?.state).toBe('working');

    // A fresh launch is issued for the same key while the old supervisor is
    // still connected (e.g. the new process then fails to start) — the old
    // connection is downgraded to unbound in place.
    registry.issueLaunch({ serverName: 'local', target: 'azito:agent-1.1', taskId: 42, unitId: 7 });
    expect(registry.snapshot()[0].bound).toBe(false);
    await monitor.tick();

    // The stale Tier 0 verdict must be gone — released back to Tier 1/2.
    diag = monitor.diagnostics().find((d) => d.target === 'azito:agent-1');
    expect(diag).toBeUndefined();
    expect(monitor.snapshot()).toHaveLength(0);

    // The now-unbound connection's own further activity must not revive it.
    registry.handleMessage(asSocket(socket), { type: 'activity', state: 'active', bytesInWindow: 12, ts: Date.now() });
    await monitor.tick();

    diag = monitor.diagnostics().find((d) => d.target === 'azito:agent-1');
    expect(diag).toBeUndefined();
    expect(monitor.snapshot()).toHaveLength(0);
  });

  it('an unbound connection`s child_exit still clears any stale Tier 0 state for its key (deletion is not authority-gated)', async () => {
    const issued = registry.issueLaunch({ serverName: 'local', target: 'azito:agent-1.1', taskId: 42, unitId: 7 })!;
    const socket = new MockSocket();
    registry.register(asSocket(socket), registerMessage({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    registry.handleMessage(asSocket(socket), { type: 'activity', state: 'active', bytesInWindow: 12, ts: Date.now() });
    await monitor.tick();
    expect(monitor.diagnostics().find((d) => d.target === 'azito:agent-1')?.decidedBy).toBe('tier0_supervisor');

    // Downgrade already cleared it via authority_revoked — reproduce the
    // remaining, independent guarantee: even if a stale entry HAD survived
    // (e.g. re-set by a race), the now-unbound connection's own child_exit
    // must still be able to clear it rather than being dropped outright.
    registry.handleMessage(asSocket(socket), { type: 'child_exit', exitCode: 0, signal: null, ts: Date.now() });
    await monitor.tick();

    expect(monitor.diagnostics().find((d) => d.target === 'azito:agent-1')).toBeUndefined();
  });
});
