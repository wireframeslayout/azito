import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import { KeyedMutex } from '../../../shared/keyedMutex';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import type { TmuxClient } from '../TmuxClient';
import { MisaoConnection, connectDedicatedMisaoClient } from '../misao/MisaoConnection';
import { MisaoMuxClient } from '../misao/MisaoMuxClient';
import { describeMisaoDaemon } from '../misao/misaoDriver';
import sessionsRoutes, { invalidateSessionCache } from './sessions';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const server = { name: 'misao-it', type: 'local', muxRuntime: 'misao' } as ServerConfig;
const SOCKET_BYTES_MAX = 107;
const WORKSPACE = 'azs-ws';
const RENAMED = 'azs-renamed';
const PANES_WS = 'azs-panes';

describe.skipIf(!fs.existsSync(MISAO_CLI))('sessions routes against a real misao daemon', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
  let socketPath: string;
  let connection: MisaoConnection;
  let app: FastifyInstance;
  const tmux = { listSessions: vi.fn(), killSession: vi.fn(), renameSession: vi.fn() };
  const warn = vi.fn();

  async function listNames(): Promise<string[]> {
    const res = await app.inject({ method: 'GET', url: `/api/servers/${server.name}/sessions` });
    expect(res.statusCode).toBe(200);
    return res.json().map((s: { name: string }) => s.name);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azs-'));
    socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    connection = new MisaoConnection({ socketPath, sdk, log: { warn } });
    const driver = new MisaoMuxClient(connection, { shell: '/bin/bash', onChange: vi.fn(), log: { warn }, hubEnv: { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh-token' }, connectAttachClient: () => connectDedicatedMisaoClient(sdk, socketPath) });
    await connection.start();

    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', driver, () => connection.availability());
    app = Fastify();
    await app.register(sessionsRoutes, {
      serverRepo: { findByName: (name: string) => (name === server.name ? server : undefined) } as unknown as IServerRepository,
      tmux: tmux as unknown as TmuxClient,
      uiToken: 'test-token', buildSecondaryWindowEnv: () => ({}),
      muxDriverRegistry: registry,
      serverIsolationMutex: new KeyedMutex(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    connection?.close();
    if (daemon && daemon.exitCode === null) {
      const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
      process.kill(daemonPid, 'SIGTERM');
      await exited;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports the daemon as installed with its protocol version', async () => {
    const status = await describeMisaoDaemon(connection);
    expect(status.installed).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+/);
  });

  it('lists an empty daemon without touching tmux', async () => {
    expect(await listNames()).toEqual([]);
    expect(tmux.listSessions).not.toHaveBeenCalled();
  });

  it('shows a workspace created through the mux route in the session list with a misao ref', async () => {
    const created = await app.inject({ method: 'POST', url: `/api/servers/${server.name}/mux/workspaces`, payload: { name: WORKSPACE, windowName: 'main' } });
    expect(created.statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: `/api/servers/${server.name}/sessions` });
    const [session] = res.json();
    expect(session.name).toBe(WORKSPACE);
    expect(JSON.parse(session.windows[0].ref)).toMatchObject({ kind: 'misao', workspace: WORKSPACE });
  });

  it('refuses the tmux-only session routes without calling tmux', async () => {
    const rename = await app.inject({ method: 'PUT', url: `/api/servers/${server.name}/sessions/${WORKSPACE}/rename`, payload: { name: RENAMED } });
    const kill = await app.inject({ method: 'DELETE', url: `/api/servers/${server.name}/sessions/${WORKSPACE}` });
    expect([rename.statusCode, kill.statusCode]).toEqual([409, 409]);
    expect(rename.json()).toEqual({ error: 'tmux_only_route' });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.renameSession).not.toHaveBeenCalled();
    expect(await listNames()).toEqual([WORKSPACE]);
  });

  it('renames the workspace through the mux route and the list follows', async () => {
    const res = await app.inject({ method: 'PUT', url: `/api/servers/${server.name}/mux/workspaces/${WORKSPACE}/rename`, payload: { name: RENAMED } });
    expect(res.statusCode).toBe(200);
    expect(await listNames()).toEqual([RENAMED]);
  });

  it('closes the workspace through the mux route and it leaves the list', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/servers/${server.name}/mux/workspaces/${RENAMED}` });
    expect(res.statusCode).toBe(200);
    expect(await listNames()).toEqual([]);
  });

  describe('panes of a window', () => {
    type ListedWindow = { ref: string; panes: Array<{ index: number; handle?: string; processState?: string }> };

    async function listWindow(): Promise<ListedWindow> {
      const res = await app.inject({ method: 'GET', url: `/api/servers/${server.name}/sessions` });
      expect(res.statusCode).toBe(200);
      const session = res.json().find((x: { name: string }) => x.name === PANES_WS);
      return session.windows[0];
    }

    const mux = (ref: string): string => `/api/servers/${server.name}/mux/windows/${encodeURIComponent(ref)}`;

    it('reports a freshly opened pane as running', async () => {
      const created = await app.inject({ method: 'POST', url: `/api/servers/${server.name}/mux/workspaces`, payload: { name: PANES_WS, windowName: 'main' } });
      expect(created.statusCode).toBe(200);
      const win = await listWindow();
      expect(win.panes).toHaveLength(1);
      expect(win.panes[0].processState).toBe('running');
    });

    it('keeps an empty window after its last pane is closed and opens a new pane in it', async () => {
      const { ref } = await listWindow();
      const closed = await app.inject({ method: 'DELETE', url: `${mux(ref)}/panes/1` });
      expect(closed.statusCode).toBe(200);
      expect((await listWindow()).panes).toEqual([]);

      const opened = await app.inject({ method: 'POST', url: `${mux(ref)}/panes/open`, payload: {} });
      expect(opened.statusCode).toBe(200);
      const win = await listWindow();
      expect(win.panes).toHaveLength(1);
      expect(win.panes[0].processState).toBe('running');
    });

    it('deletes a pane by its handle: a repeated delete is a no-op and never takes a sibling that moved up', async () => {
      const { ref } = await listWindow();
      for (let i = 0; i < 2; i++) {
        const opened = await app.inject({ method: 'POST', url: `${mux(ref)}/panes/open`, payload: {} });
        expect(opened.statusCode).toBe(200);
      }
      const [first, second, third] = (await listWindow()).panes.map((p) => p.handle!);
      expect(third).toBeDefined();

      const url = `${mux(ref)}/panes/2?handle=${encodeURIComponent(second)}`;
      expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url })).statusCode).toBe(200);
      expect((await listWindow()).panes.map((p) => p.handle)).toEqual([first, third]);

      expect((await app.inject({ method: 'DELETE', url: `${mux(ref)}/panes/1?handle=not-a-handle` })).statusCode).toBe(400);
      expect((await app.inject({ method: 'DELETE', url: `${mux(ref)}/panes/1?handle=${encodeURIComponent(third)}` })).statusCode).toBe(200);
      expect((await listWindow()).panes.map((p) => p.handle)).toEqual([first]);
    });

    it('refuses a handle that belongs to another window and leaves that pane alone', async () => {
      const { ref } = await listWindow();
      const created = await app.inject({ method: 'POST', url: `/api/servers/${server.name}/mux/workspaces/${PANES_WS}/windows`, payload: { name: 'other' } });
      expect(created.statusCode).toBe(200);
      const otherRef = created.json().ref as string;
      const res = await app.inject({ method: 'GET', url: `/api/servers/${server.name}/sessions` });
      const windows = res.json().find((x: { name: string }) => x.name === PANES_WS).windows as ListedWindow[];
      const otherHandle = windows.find((w) => w.ref === otherRef)!.panes[0].handle!;

      const refused = await app.inject({ method: 'DELETE', url: `${mux(ref)}/panes/1?handle=${encodeURIComponent(otherHandle)}` });
      expect(refused.statusCode).toBe(404);
      const after = await app.inject({ method: 'GET', url: `/api/servers/${server.name}/sessions` });
      const afterWindows = after.json().find((x: { name: string }) => x.name === PANES_WS).windows as ListedWindow[];
      expect(afterWindows.find((w) => w.ref === otherRef)!.panes.map((p) => p.handle)).toEqual([otherHandle]);
    });

    it('shows a pane restored after a daemon restart as stopped and deletes it', async () => {
      const { ref } = await listWindow();
      const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()));
      process.kill(daemonPid, 'SIGTERM');
      await exited;
      daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
      daemonPid = daemon.pid!;

      await vi.waitFor(async () => {
        invalidateSessionCache(server.name);
        const res = await app.inject({ method: 'GET', url: `/api/servers/${server.name}/sessions` });
        expect(res.statusCode).toBe(200);
        const win = res.json().find((x: { name: string }) => x.name === PANES_WS).windows[0] as ListedWindow;
        expect(win.panes.map((p) => p.processState)).toEqual(['stopped']);
      }, { timeout: 15000, interval: 200 });

      const deleted = await app.inject({ method: 'DELETE', url: `${mux(ref)}/panes/1` });
      expect(deleted.statusCode).toBe(200);
      expect((await listWindow()).panes).toEqual([]);
    }, 30000);
  });
});
