import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { MuxRef, PaneOrdinal } from '@azito/shared';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import { TransportFactory } from '../servers/transport/TransportFactory';
import { TmuxClient } from './TmuxClient';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import type { MisaoConnection } from './misao/MisaoConnection';
import { registerMisaoDriver } from './misao/misaoDriver';
import { handleTerminalConnection } from './ws/terminalHandler';
import sessionsRoutes, { invalidateSessionCache } from './routes/sessions';
import { KeyedMutex } from '../../shared/keyedMutex';

// One local server holding a tmux window and a misao window side by side (#311), driven through the routing driver.
// tmux runs on a throwaway socket (TMUX_TMPDIR) and misao is a throwaway daemon: the resident ones are never touched.
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const SOCKET_BYTES_MAX = 107;
const WORKSPACE = 'azr-mixed';
const server = { name: 'local', type: 'local', defaultMux: 'tmux' as const, muxRuntime: 'system' } as ServerConfig;
const misaoDefault = { ...server, name: 'local-misao', defaultMux: 'misao' as const } as ServerConfig;

interface FakeWs extends EventEmitter {
  OPEN: number;
  readyState: number;
  sent: string[];
  send(data: string): void;
  close(): void;
  ping(): void;
  terminate(): void;
}

function fakeWs(): FakeWs {
  const ws = new EventEmitter() as FakeWs;
  ws.OPEN = 1;
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => { ws.sent.push(typeof data === 'string' ? data : String(data)); };
  ws.close = () => { ws.readyState = 3; };
  ws.ping = () => {};
  ws.terminate = () => {};
  return ws;
}

describe.skipIf(!fs.existsSync(MISAO_CLI))('one local server with a tmux and a misao window (routing driver)', () => {
  const savedEnv = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  let tmuxDir: string;
  let misaoDir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let connection: MisaoConnection;
  let registry: MuxDriverRegistry;
  let tmuxClient: TmuxClient;
  let app: FastifyInstance;
  let tmuxRef: MuxRef;
  let misaoRef: MuxRef;
  const sockets: FakeWs[] = [];

  const tmuxSocket = (): string => path.join(tmuxDir, `tmux-${process.getuid!()}`, 'default');

  beforeAll(async () => {
    // Every tmux the hub code starts from here (exec and the attach pty inherit the env) uses this socket directory.
    tmuxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azt-'));
    process.env.TMUX_TMPDIR = tmuxDir;
    delete process.env.TMUX;

    misaoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azm-'));
    const socketPath = path.join(misaoDir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', misaoDir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    registry = new MuxDriverRegistry();
    tmuxClient = new TmuxClient(new TransportFactory('http://127.0.0.1:1'), 'http://127.0.0.1:1', 'ui', 'http://127.0.0.1:1', 'wh');
    registry.register('tmux', tmuxClient);
    const sdk = await import('@misao/sdk');
    const handle = registerMisaoDriver(registry, { sdk, socketPath, shell: '/bin/bash' }, () => {}, { warn: () => {} }, { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' });
    connection = handle.connection;
    await connection.start();
    expect(connection.availability()).toEqual({ available: true });

    app = Fastify();
    await app.register(sessionsRoutes, {
      serverRepo: { findByName: (name: string) => [server, misaoDefault].find((s) => s.name === name) } as unknown as IServerRepository,
      tmux: tmuxClient,
      uiToken: 'ui',
      muxDriverRegistry: registry,
      serverIsolationMutex: new KeyedMutex(),
      buildSecondaryWindowEnv: () => ({}),
    });
    await app.ready();
  });

  afterAll(async () => {
    for (const ws of sockets) ws.emit('close');
    await app?.close();
    connection?.close();
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
      process.kill(daemonPid, 'SIGTERM');
      await exited;
    }
    // Only the throwaway socket is addressed (-S), never the default one.
    if (tmuxDir && fs.existsSync(tmuxSocket())) {
      try { execFileSync('tmux', ['-S', tmuxSocket(), 'kill-server'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    if (tmuxDir) fs.rmSync(tmuxDir, { recursive: true, force: true });
    if (misaoDir) fs.rmSync(misaoDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('creates a tmux window by default and a misao window on request, in same-named workspaces', async () => {
    const routing = registry.resolve(server);
    expect(registry.usableKinds(server)).toEqual(['tmux', 'misao']);

    tmuxRef = (await routing.openWorkspace(server, WORKSPACE, { windowName: 'tw', exactName: true })).ref;
    misaoRef = (await routing.openWorkspace(server, WORKSPACE, { windowName: 'mw', exactName: true, kind: 'misao' })).ref;

    expect(tmuxRef).toEqual({ kind: 'tmux', workspace: WORKSPACE, window: 'tw' });
    expect(misaoRef).toMatchObject({ kind: 'misao', workspace: WORKSPACE });
    expect(fs.existsSync(tmuxSocket())).toBe(true);
  });

  it('lists both through GET /sessions, each stamped with its kind, nothing unavailable', async () => {
    invalidateSessionCache(server.name);
    const res = await app.inject({ method: 'GET', url: `/api/servers/${server.name}/sessions?detail=1` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Array<{ name: string; kind: string; windows: Array<{ ref: string }> }>; unavailable: unknown[] };
    const mixed = body.sessions.filter((s) => s.name === WORKSPACE);
    expect(mixed.map((s) => s.kind).sort()).toEqual(['misao', 'tmux']);
    expect(mixed.find((s) => s.kind === 'misao')!.windows.map((w) => JSON.parse(w.ref))).toContainEqual(misaoRef);
    expect(body.unavailable).toEqual([]);
  });

  it('sends input to each window through its own mux, told by the pane handle', async () => {
    const routing = registry.resolve(server);
    for (const [ref, marker] of [[tmuxRef, 'azr-tmux-ok'], [misaoRef, 'azr-misao-ok']] as const) {
      const handle = await routing.resolvePane(server, ref, 1 as PaneOrdinal);
      expect(handle.startsWith('p_')).toBe(ref.kind === 'misao');
      // The typed line holds `$((20+22))`; only the shell's output holds `42`.
      await routing.sendTextToHandle(server, handle, `echo $((20+22))-${marker}`);
      await routing.sendKeysToHandle(server, handle, ['Enter']);
      await vi.waitFor(async () => {
        const screen = await routing.captureScreen(server, handle);
        expect(screen.stdout).toContain(`42-${marker}`);
      }, { timeout: 15000, interval: 100 });
    }
  });

  it('attaches a browser terminal to each window through the routing driver', async () => {
    for (const [ref, marker] of [[tmuxRef, 'azr-attach-tmux'], [misaoRef, 'azr-attach-misao']] as const) {
      const ws = fakeWs();
      sockets.push(ws);
      handleTerminalConnection(ws as unknown as WebSocket, server, ref, 1 as PaneOrdinal, 100, 30, registry);
      await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0), { timeout: 15000, interval: 50 });
      ws.emit('message', `echo ${marker}-$((40+2))\r`);
      await vi.waitFor(() => expect(ws.sent.join('')).toContain(`${marker}-42`), { timeout: 15000, interval: 50 });
      ws.emit('close');
    }
  });

  it('closes the misao window through the routing driver and leaves the tmux one alone', async () => {
    const routing = registry.resolve(server);
    expect((await routing.closeWindow(server, misaoRef)).code).toBe(0);
    expect(await routing.windowExists(server, misaoRef)).toBe(false);
    expect(await routing.windowExists(server, tmuxRef)).toBe(true);
  });

  it('keeps listing tmux on a misao-default server whose daemon went away, and reports misao as unavailable', async () => {
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
    process.kill(daemonPid, 'SIGTERM');
    await exited;
    await vi.waitFor(() => expect(connection.availability().available).toBe(false), { timeout: 10000, interval: 50 });

    invalidateSessionCache(misaoDefault.name);
    const res = await app.inject({ method: 'GET', url: `/api/servers/${misaoDefault.name}/sessions?detail=1` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: Array<{ name: string; kind: string }>; unavailable: Array<{ kind: string; reason: string }> };
    expect(body.sessions.filter((s) => s.name === WORKSPACE).map((s) => s.kind)).toEqual(['tmux']);
    expect(body.unavailable).toEqual([expect.objectContaining({ kind: 'misao', reason: 'daemon_unreachable' })]);
  });

  it('closes the tmux window through the routing driver, leaving no tmux session behind', async () => {
    const routing = registry.resolve(server);
    expect(registry.usableKinds(server)).toEqual(['tmux']);
    const closed = await routing.closeWindow(server, tmuxRef);
    expect(closed.code).toBe(0);
    const left = await routing.listWorkspaces(server);
    expect(left.filter((ws) => ws.name === WORKSPACE)).toEqual([]);
  });
});
