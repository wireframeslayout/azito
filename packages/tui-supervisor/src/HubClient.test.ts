import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubClient } from './HubClient';
import { ReadinessGate } from './ReadinessGate';
import type { SupervisorToHubMessage } from './protocol';

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Conn {
  socket: ServerSocket;
  request: IncomingMessage;
  messages: SupervisorToHubMessage[];
}

describe('HubClient', () => {
  let server: WebSocketServer;
  let url: string;
  let connections: Conn[];
  let client: HubClient | undefined;
  let written: string[];
  let writeImpl: (data: string) => void;

  /** Auto-ack registration for every new connection when true. */
  let autoRegister: boolean;

  beforeEach(async () => {
    connections = [];
    written = [];
    autoRegister = true;
    writeImpl = (data) => written.push(data);
    server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
    server.on('connection', (socket, request) => {
      const conn: Conn = { socket, request, messages: [] };
      connections.push(conn);
      socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as SupervisorToHubMessage;
        conn.messages.push(msg);
        if (autoRegister && msg.type === 'register') {
          socket.send(JSON.stringify({ type: 'registered' }));
        }
      });
    });
  });

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeClient(overrides: Partial<ConstructorParameters<typeof HubClient>[0]> = {}): HubClient {
    client = new HubClient({
      url,
      token: 'test-token',
      register: {
        serverName: 'local',
        target: 'sess:1.0',
        taskId: 42,
        unitId: null,
        pid: process.pid,
        childCommand: 'claude',
      },
      write: (data) => writeImpl(data),
      heartbeatMs: 50,
      backoffBaseMs: 30,
      backoffMaxMs: 100,
      submitDelayMs: 20,
      firstSubmitDelayMs: 20,
      ...overrides,
    });
    return client;
  }

  it('connects with the Bearer auth header and sends register', async () => {
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    expect(connections[0].request.headers.authorization).toBe('Bearer test-token');
    const register = connections[0].messages[0];
    expect(register).toMatchObject({
      type: 'register',
      protocolVersion: 1,
      serverName: 'local',
      target: 'sess:1.0',
      taskId: 42,
      unitId: null,
      childCommand: 'claude',
      reportsReady: true,
    });
  });

  it('sends heartbeats after registration', async () => {
    makeClient().connect();
    await waitFor(() => connections[0]?.messages.some((m) => m.type === 'heartbeat'));
  });

  it('handles inject_prompt with bracketed paste, delayed submit, and ack', async () => {
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.send(
      JSON.stringify({ type: 'inject_prompt', id: 'p1', text: 'こんにちは', submit: true }),
    );
    await waitFor(() => written.length >= 1);
    expect(written[0]).toBe('\x1b[200~こんにちは\x1b[201~');
    await waitFor(() => written.length >= 2);
    expect(written[1]).toBe('\r');
    await waitFor(() => connections[0].messages.some((m) => m.type === 'ack'));
    expect(connections[0].messages.find((m) => m.type === 'ack')).toEqual({
      type: 'ack',
      id: 'p1',
      ok: true,
    });
  });

  describe('readiness gate', () => {
    it('delays inject_prompt until enough child output + quiet period', async () => {
      const gate = new ReadinessGate({ quietMs: 80, minOutputBytes: 100, maxWaitMs: 1_000 });
      makeClient({ readiness: gate, submitDelayMs: 5 }).connect();
      await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
      connections[0].socket.send(
        JSON.stringify({ type: 'inject_prompt', id: 'g1', text: 'early', submit: false }),
      );
      // No child output yet: nothing may be written even well past network latency.
      await new Promise((r) => setTimeout(r, 120));
      expect(written).toEqual([]);
      // Enough output arrives, but the quiet period has not elapsed yet.
      gate.notifyOutput(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(written).toEqual([]);
      // Quiet period elapses -> paste goes through, then the ack.
      await waitFor(() => written.length === 1);
      expect(written[0]).toBe('\x1b[200~early\x1b[201~');
      await waitFor(() => connections[0].messages.some((m) => m.type === 'ack'));
      expect(connections[0].messages.find((m) => m.type === 'ack')).toMatchObject({ id: 'g1', ok: true });
    });

    it('injects immediately when the child is already ready', async () => {
      const gate = new ReadinessGate({ quietMs: 30, minOutputBytes: 100, maxWaitMs: 1_000 });
      gate.notifyOutput(4_096);
      await waitFor(() => gate.isReady());
      makeClient({ readiness: gate }).connect();
      await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
      const before = Date.now();
      connections[0].socket.send(
        JSON.stringify({ type: 'inject_prompt', id: 'g2', text: 'now', submit: false }),
      );
      await waitFor(() => written.length === 1);
      // Ready gate resolves synchronously; only network latency remains.
      expect(Date.now() - before).toBeLessThan(500);
      expect(written[0]).toBe('\x1b[200~now\x1b[201~');
    });

    it('forces the injection after maxWaitMs even if the child never became ready', async () => {
      const gate = new ReadinessGate({ quietMs: 50, maxWaitMs: 150 });
      makeClient({ readiness: gate }).connect();
      await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
      connections[0].socket.send(
        JSON.stringify({ type: 'inject_prompt', id: 'g3', text: 'forced', submit: false }),
      );
      // Never call notifyOutput: the gate's cap must release the injection.
      await waitFor(() => written.length === 1);
      expect(written[0]).toBe('\x1b[200~forced\x1b[201~');
      await waitFor(() => connections[0].messages.some((m) => m.type === 'ack'));
      expect(connections[0].messages.find((m) => m.type === 'ack')).toMatchObject({ id: 'g3', ok: true });
      expect(gate.isReady()).toBe(false);
    });
  });

  it('acks inject_prompt(submit:true) only AFTER the submitting \\r is written', async () => {
    // This is the client's FIRST inject, so firstSubmitDelayMs applies.
    makeClient({ firstSubmitDelayMs: 100 }).connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.send(
      JSON.stringify({ type: 'inject_prompt', id: 'order-1', text: 'run it', submit: true }),
    );
    // Right after the paste write, the 100ms submit delay has not elapsed:
    // no ack may exist yet.
    await waitFor(() => written.length >= 1);
    expect(written).toEqual(['\x1b[200~run it\x1b[201~']);
    expect(connections[0].messages.some((m) => m.type === 'ack')).toBe(false);
    // When the ack arrives, the \r must already have been written.
    await waitFor(() => connections[0].messages.some((m) => m.type === 'ack'));
    expect(written).toEqual(['\x1b[200~run it\x1b[201~', '\r']);
    expect(connections[0].messages.find((m) => m.type === 'ack')).toEqual({
      type: 'ack',
      id: 'order-1',
      ok: true,
    });
  });

  it('uses the longer first-inject submit delay, then the short delay from the 2nd inject on', async () => {
    // Scaled-down thresholds (real values: 2000ms first / 150ms after).
    const writeTimes: Array<{ data: string; ts: number }> = [];
    writeImpl = (data) => {
      written.push(data);
      writeTimes.push({ data, ts: Date.now() });
    };
    makeClient({ firstSubmitDelayMs: 300, submitDelayMs: 20 }).connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);

    // First inject: boot-time timing.
    connections[0].socket.send(
      JSON.stringify({ type: 'inject_prompt', id: 'first', text: 'one', submit: true }),
    );
    await waitFor(() => written.length === 2);
    const firstGap = writeTimes[1].ts - writeTimes[0].ts;
    expect(firstGap).toBeGreaterThanOrEqual(280);

    // Second inject: the child TUI is proven running -> short delay.
    connections[0].socket.send(
      JSON.stringify({ type: 'inject_prompt', id: 'second', text: 'two', submit: true }),
    );
    await waitFor(() => written.length === 4);
    const secondGap = writeTimes[3].ts - writeTimes[2].ts;
    expect(secondGap).toBeLessThan(200);
    expect(secondGap).toBeGreaterThanOrEqual(15);
  });

  it('acks ok:false when the delayed submit \\r write throws', async () => {
    writeImpl = (data) => {
      if (data === '\r') throw new Error('child exited during submit delay');
      written.push(data);
    };
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.send(
      JSON.stringify({ type: 'inject_prompt', id: 'fail-enter', text: 'doomed', submit: true }),
    );
    await waitFor(() => connections[0].messages.some((m) => m.type === 'ack'));
    expect(written).toEqual(['\x1b[200~doomed\x1b[201~']);
    expect(connections[0].messages.find((m) => m.type === 'ack')).toEqual({
      type: 'ack',
      id: 'fail-enter',
      ok: false,
      error: 'child exited during submit delay',
    });
  });

  describe('ready reporting', () => {
    it('drops sendReady while unregistered instead of buffering', async () => {
      autoRegister = false;
      const c = makeClient();
      c.connect();
      await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
      c.sendReady();
      await new Promise((r) => setTimeout(r, 50));
      expect(connections[0].messages.filter((m) => m.type === 'ready')).toHaveLength(0);
    });

    it('sends a ready frame when registered', async () => {
      const c = makeClient();
      c.connect();
      await waitFor(() => connections[0]?.messages.some((m) => m.type === 'heartbeat'));
      c.sendReady();
      await waitFor(() => connections[0].messages.some((m) => m.type === 'ready'));
      expect(connections[0].messages.find((m) => m.type === 'ready')).toMatchObject({ type: 'ready' });
    });

    it('auto-sends ready on the registered handshake when the gate is already latched', async () => {
      const gate = new ReadinessGate({ quietMs: 20, minOutputBytes: 10, maxWaitMs: 1_000 });
      gate.notifyOutput(50);
      await waitFor(() => gate.isReady(), 1_000);
      makeClient({ readiness: gate }).connect();
      await waitFor(() => connections[0]?.messages.some((m) => m.type === 'ready'));
      expect(connections[0].messages.find((m) => m.type === 'ready')).toMatchObject({ type: 'ready' });
    });
  });

  it('handles send_keys via the keymap', async () => {
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.send(JSON.stringify({ type: 'send_keys', id: 'k1', keys: ['Up', 'Enter', 'x'] }));
    await waitFor(() => written.length >= 1);
    expect(written[0]).toBe('\x1b[A\rx');
  });

  it('handles interrupt as Ctrl-C', async () => {
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.send(JSON.stringify({ type: 'interrupt', id: 'i1' }));
    await waitFor(() => written.length >= 1);
    expect(written[0]).toBe('\x03');
  });

  it('acks ok:false when the pty write throws', async () => {
    writeImpl = () => {
      throw new Error('pty is gone');
    };
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.send(JSON.stringify({ type: 'interrupt', id: 'i2' }));
    await waitFor(() => connections[0].messages.some((m) => m.type === 'ack'));
    expect(connections[0].messages.find((m) => m.type === 'ack')).toEqual({
      type: 'ack',
      id: 'i2',
      ok: false,
      error: 'pty is gone',
    });
  });

  it('reconnects with backoff after a disconnect', async () => {
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.terminate();
    await waitFor(() => connections.length === 2);
    await waitFor(() => connections[1].messages.some((m) => m.type === 'register'));
  });

  it('buffers child_exit while disconnected and re-sends it after reconnect', async () => {
    const c = makeClient();
    c.connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.terminate();
    await new Promise((r) => setTimeout(r, 10));
    c.sendChildExit(null, 2);
    await waitFor(() => connections.length === 2);
    await waitFor(() => connections[1].messages.some((m) => m.type === 'child_exit'));
    expect(connections[1].messages.find((m) => m.type === 'child_exit')).toMatchObject({
      type: 'child_exit',
      exitCode: null,
      signal: 2,
    });
  });

  it('drops activity while unregistered instead of buffering', async () => {
    autoRegister = false;
    const c = makeClient();
    c.connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    c.sendActivity('active', 500);
    await new Promise((r) => setTimeout(r, 50));
    expect(connections[0].messages.filter((m) => m.type === 'activity')).toHaveLength(0);
  });

  it('sends activity when registered', async () => {
    const c = makeClient();
    c.connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.some((m) => m.type === 'register'));
    await waitFor(() => connections[0].messages.length >= 1);
    // Wait until 'registered' handshake completes client-side (first heartbeat proves it).
    await waitFor(() => connections[0].messages.some((m) => m.type === 'heartbeat'));
    c.sendActivity('active', 1234);
    await waitFor(() => connections[0].messages.some((m) => m.type === 'activity'));
    expect(connections[0].messages.find((m) => m.type === 'activity')).toMatchObject({
      state: 'active',
      bytesInWindow: 1234,
    });
  });

  it('survives invalid JSON from the hub and keeps handling commands', async () => {
    makeClient().connect();
    await waitFor(() => connections.length === 1 && connections[0].messages.length >= 1);
    connections[0].socket.send('this is not json{{{');
    connections[0].socket.send(JSON.stringify({ type: 'interrupt', id: 'after-garbage' }));
    await waitFor(() => written.length >= 1);
    expect(written[0]).toBe('\x03');
  });
});
