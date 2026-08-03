import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { SupervisorRegistry } from './SupervisorRegistry';
import { SUPERVISOR_PROTOCOL_VERSION, type RegisterMessage } from './protocol';

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

    expect(onDisconnected).toHaveBeenCalledWith({ serverName: 'local', target: 'test:0.1' });
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
      childCommand: 'bash',
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
