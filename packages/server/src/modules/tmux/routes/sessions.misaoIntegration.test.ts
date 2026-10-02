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
import sessionsRoutes from './sessions';

// Drives a real misao daemon started in a throwaway directory (never the resident ~/.misao one).
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const server = { name: 'misao-it', type: 'local', muxRuntime: 'misao' } as ServerConfig;
const SOCKET_BYTES_MAX = 107;
const WORKSPACE = 'azs-ws';
const RENAMED = 'azs-renamed';

describe.skipIf(!fs.existsSync(MISAO_CLI))('sessions routes against a real misao daemon', () => {
  let dir: string;
  let daemon: ChildProcess;
  let daemonPid: number;
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
    const socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], { stdio: 'ignore' });
    daemonPid = daemon.pid!;
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    const sdk = await import('@misao/sdk');
    connection = new MisaoConnection({ socketPath, sdk, log: { warn } });
    const driver = new MisaoMuxClient(connection, { shell: '/bin/bash', onChange: vi.fn(), log: { warn }, connectAttachClient: () => connectDedicatedMisaoClient(sdk, socketPath) });
    await connection.start();

    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', driver, () => connection.availability());
    app = Fastify();
    await app.register(sessionsRoutes, {
      serverRepo: { findByName: (name: string) => (name === server.name ? server : undefined) } as unknown as IServerRepository,
      tmux: tmux as unknown as TmuxClient,
      uiToken: 'test-token',
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
});
