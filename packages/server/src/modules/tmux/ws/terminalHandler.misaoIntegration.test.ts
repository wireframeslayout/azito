import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WebSocket } from 'ws';
import type { MuxRef, PaneOrdinal } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import { MisaoConnection } from '../misao/MisaoConnection';
import { registerMisaoDriver } from '../misao/misaoDriver';
import type { MisaoMuxClient } from '../misao/MisaoMuxClient';
import { handleTerminalConnection } from './terminalHandler';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const server = { name: 'local', type: 'local', muxRuntime: 'misao' } as ServerConfig;
const SOCKET_BYTES_MAX = 107;
const transportFactory = { getTransport: () => { throw new Error('tmux transport must not be used'); } } as unknown as TransportFactory;

interface FakeWs extends EventEmitter {
  OPEN: number;
  readyState: number;
  sent: string[];
  send(data: string): void;
  close: ReturnType<typeof vi.fn>;
  ping(): void;
  terminate(): void;
}

function fakeWs(): FakeWs {
  const ws = new EventEmitter() as FakeWs;
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => { ws.sent.push(data); };
  ws.close = vi.fn(() => { ws.readyState = 3; });
  ws.ping = () => {};
  ws.terminate = () => {};
  return ws;
}

describe.skipIf(!fs.existsSync(MISAO_CLI))('browser terminal against a real misao daemon', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let connection: MisaoConnection;
  let driver: MisaoMuxClient;
  let registry: MuxDriverRegistry;
  let ref: MuxRef;
  let paneId: string;
  const open: FakeWs[] = [];

  function attach(target: MuxRef, cols: number, rows: number): FakeWs {
    const ws = fakeWs();
    open.push(ws);
    handleTerminalConnection(ws as unknown as WebSocket, server, target, 1 as PaneOrdinal, cols, rows, transportFactory, registry);
    return ws;
  }

  const output = (ws: FakeWs): string => ws.sent.join('');

  async function paneInfo() {
    return connection.request('pane.info', { paneId });
  }

  async function clientIds(): Promise<string[]> {
    return (await paneInfo()).clients;
  }

  async function attachAndWait(cols: number, rows: number): Promise<FakeWs> {
    const ws = attach(ref, cols, rows);
    await vi.waitFor(() => expect(output(ws)).toContain('\x1b[2J'), { timeout: 10000, interval: 50 });
    return ws;
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azm-'));
    const socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    registry = new MuxDriverRegistry({ misaoEnabled: true });
    const handle = registerMisaoDriver(registry, { sdk, socketPath, shell: '/bin/bash' }, () => {}, { warn: () => {} }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' });
    connection = handle.connection;
    driver = handle.driver;
    await connection.start();
    expect(connection.availability()).toEqual({ available: true });

    const opened = await driver.openWorkspace(server, 'azm-term', { windowName: 'main', exactName: true });
    ref = opened.ref;
    paneId = (await driver.listPanesByRef(server, ref))[0].handle;
  });

  afterAll(async () => {
    for (const ws of open) ws.emit('close');
    connection?.close();
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
      process.kill(daemonPid, 'SIGTERM');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attaches and starts with a screen snapshot, registering one client on the pane', async () => {
    const ws = await attachAndWait(100, 30);
    expect(await clientIds()).toHaveLength(1);
    ws.emit('close');
    await vi.waitFor(async () => expect(await clientIds()).toEqual([]), { timeout: 10000, interval: 50 });
  });

  it('runs typed input in the pane and streams the output back', async () => {
    const ws = await attachAndWait(100, 30);
    ws.emit('message', 'echo azito-b3-$((40+2))\r');
    await vi.waitFor(() => expect(output(ws)).toContain('azito-b3-42'), { timeout: 10000, interval: 50 });
    ws.emit('close');
  });

  it('resizes the pane to the terminal that asked, and hands the size to whoever acted last', async () => {
    const first = await attachAndWait(100, 30);
    first.emit('message', JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
    await vi.waitFor(async () => {
      const info = await paneInfo();
      expect([info.cols, info.rows]).toEqual([90, 20]);
    }, { timeout: 10000, interval: 50 });
    const firstId = (await paneInfo()).sizeOwner;

    const second = await attachAndWait(70, 25);
    second.emit('message', JSON.stringify({ type: 'resize', cols: 70, rows: 25 }));
    await vi.waitFor(async () => {
      const info = await paneInfo();
      expect([info.cols, info.rows]).toEqual([70, 25]);
      expect(info.sizeOwner).not.toBe(firstId);
    }, { timeout: 10000, interval: 50 });

    first.emit('message', 'true\r');
    await vi.waitFor(async () => expect((await paneInfo()).sizeOwner).toBe(firstId), { timeout: 10000, interval: 50 });
    first.emit('close');
    second.emit('close');
  });

  it('detaches the client when the socket closes', async () => {
    const ws = await attachAndWait(100, 30);
    expect(await clientIds()).toHaveLength(1);
    ws.emit('close');
    await vi.waitFor(async () => expect(await clientIds()).toEqual([]), { timeout: 10000, interval: 50 });
  });

  it('closes with 4404 for a window that does not exist', async () => {
    const ws = attach({ kind: 'misao', workspace: 'azm-term', window: 'w_00000000000000000000000000' }, 80, 24);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(4404, 'window not found'), { timeout: 10000, interval: 50 });
  });

  it('closes the socket when the window is closed under it', async () => {
    const extra = (await driver.openWindow(server, 'azm-term', 'extra', { exactName: true })).ref;
    const ws = attach(extra, 80, 24);
    await vi.waitFor(() => expect(output(ws)).toContain('\x1b[2J'), { timeout: 10000, interval: 50 });
    await driver.closeWindow(server, extra);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(4413, 'pane closed'), { timeout: 10000, interval: 50 });
  });

  it('closes with 4413 when the watched pane is closed, and a later attach to its old ordinal does not land on the pane that took its place', async () => {
    const twoPanes = (await driver.openWindow(server, 'azm-term', 'two', { exactName: true })).ref;
    const second = await driver.openPaneInWindow(server, twoPanes);
    const ws = attach(twoPanes, 80, 24);
    await vi.waitFor(() => expect(output(ws)).toContain('\x1b[2J'), { timeout: 10000, interval: 50 });
    // Pane 1 is watched; closing it shifts the other pane into ordinal 1.
    const [first] = await driver.listPanesByRef(server, twoPanes);
    await driver.closePane(server, first.handle);
    await vi.waitFor(() => expect(ws.close).toHaveBeenCalledWith(4413, 'pane closed'), { timeout: 10000, interval: 50 });
    expect((await driver.listPanesByRef(server, twoPanes)).map((p) => p.handle)).toEqual([second]);
    // Ordinal 2 no longer names a pane: the hub says so instead of failing generically.
    const stale = fakeWs();
    open.push(stale);
    handleTerminalConnection(stale as unknown as WebSocket, server, twoPanes, 2 as PaneOrdinal, 80, 24, transportFactory, registry);
    await vi.waitFor(() => expect(stale.close).toHaveBeenCalledWith(4413, 'pane closed'), { timeout: 10000, interval: 50 });
  });
});
