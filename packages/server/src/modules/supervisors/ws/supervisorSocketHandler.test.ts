import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import type { WebSocket } from 'ws';
import { SupervisorRegistry } from '../SupervisorRegistry';
import { SqliteSupervisorLaunchRepository } from '../SupervisorLaunchRepository';
import { SqliteServerAliasRepository } from '../../servers/SqliteServerAliasRepository';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';
import type { SqliteDatabase } from '../../../shared/db/Database';
import { handleSupervisorConnection } from './supervisorSocketHandler';

// TODO(#313): remove with the server alias compatibility.
// The real handler, registry and launch repository: a supervisor started before migration 079 merged `local-misao`
// into `local` still registers with the old name and the launch the hub issued for `local`.

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(code = 1000, reason = ''): void { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
  terminate(): void { this.readyState = 3; this.emit('close'); }
  ping(): void { /* no-op */ }
  receive(msg: unknown): void { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}

const TARGET = 'ws:w_01M3XFD8H97JCPKS5Y5BH3JZQH';
const register = (over: Record<string, unknown>) => ({
  type: 'register', protocolVersion: 1, serverName: 'local-misao', target: TARGET, taskId: 42, unitId: 7, pid: 1, childCommand: 'claude', reportsReady: true, ...over,
});

describe('supervisor register with a merged server\'s old name', () => {
  let db: Database.Database;
  let registry: SupervisorRegistry;
  let aliases: SqliteServerAliasRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE servers (name TEXT PRIMARY KEY);
      CREATE TABLE server_aliases (old_name TEXT PRIMARY KEY, new_name TEXT NOT NULL REFERENCES servers(name), created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE supervisor_launches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, launch_id TEXT NOT NULL, server_name TEXT NOT NULL, target TEXT NOT NULL,
        task_id INTEGER, unit_id INTEGER, window_id INTEGER, bootstrap_hash TEXT NOT NULL, session_hash TEXT, mux_pane_ref TEXT,
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT (datetime('now')), last_registered_at TEXT
      );
      CREATE UNIQUE INDEX idx_launch_id ON supervisor_launches(launch_id);
      CREATE UNIQUE INDEX idx_session_hash ON supervisor_launches(session_hash);
    `);
    db.prepare("INSERT INTO servers (name) VALUES ('local')").run();
    db.prepare("INSERT INTO server_aliases (old_name, new_name) VALUES ('local-misao', 'local')").run();
    aliases = new SqliteServerAliasRepository(db as unknown as SqliteDatabase);
    registry = new SupervisorRegistry(new SqliteSupervisorLaunchRepository(db as unknown as SqliteDatabase), { record: vi.fn() } as unknown as AuditLogService, true);
  });
  afterEach(() => db.close());

  function connect(): FakeSocket {
    const socket = new FakeSocket();
    handleSupervisorConnection(socket as unknown as WebSocket, registry, (name) => aliases.resolve(name));
    return socket;
  }

  it('accepts a correct reconnect (launch id + bootstrap token) under the old name and registers it for the merge target', () => {
    const issued = registry.issueLaunch({ serverName: 'local', target: TARGET, taskId: 42, unitId: 7 })!;
    const socket = connect();
    socket.receive(register({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    expect(socket.closed).toBeNull();
    expect(socket.sent[0]).toMatchObject({ type: 'registered', sessionToken: expect.any(String) });
    expect(registry.isConnected('local', TARGET)).toBe(true);
    expect(registry.isConnected('local-misao', TARGET)).toBe(false);
  });

  it('still rejects a wrong token', () => {
    const issued = registry.issueLaunch({ serverName: 'local', target: TARGET, taskId: 42, unitId: 7 })!;
    const socket = connect();
    socket.receive(register({ launchId: issued.launchId, bootstrapToken: 'not-the-token' }));
    expect(socket.closed?.code).toBe(4001);
    expect(registry.isConnected('local', TARGET)).toBe(false);
  });

  it('still rejects a launch issued for another target', () => {
    const other = registry.issueLaunch({ serverName: 'local', target: 'ws:w_01M3XFD8H97JCPKS5Y5BH3JZQJ', taskId: 42, unitId: 7 })!;
    const socket = connect();
    socket.receive(register({ launchId: other.launchId, bootstrapToken: other.bootstrapToken }));
    expect(socket.closed?.code).toBe(4001);
    expect(registry.isConnected('local', TARGET)).toBe(false);
  });

  it('does not apply the alias once a server was created again under the old name', () => {
    db.prepare("INSERT INTO servers (name) VALUES ('local-misao')").run();
    const issued = registry.issueLaunch({ serverName: 'local', target: TARGET, taskId: 42, unitId: 7 })!;
    const socket = connect();
    socket.receive(register({ launchId: issued.launchId, bootstrapToken: issued.bootstrapToken }));
    // It is the new server's supervisor now: the launch issued for `local` does not match.
    expect(socket.closed?.code).toBe(4001);
    expect(registry.isConnected('local', TARGET)).toBe(false);
  });
});
