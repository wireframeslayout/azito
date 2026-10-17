import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { asPaneHandle, type MuxRef, type PaneHandle } from '@azito/shared';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { IWindowRepository, Window } from '../windows/Window';
import { TransportFactory } from '../servers/transport/TransportFactory';
import type { AgentTransport } from '../servers/transport/AgentTransport';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { MuxDriverUnavailableError } from '../tmux/MuxCapabilityError';
import { registerMisaoDriver, type MisaoHandle } from '../tmux/misao/misaoDriver';
import { MisaoPaneStateEvents } from '../tmux/misao/misaoPaneStateEvents';
import { PaneStreamFactory } from '../tmux/PaneStreamFactory';
import { MisaoActivityBridge } from './misaoActivityBridge';
import { PaneHandleResolver } from './PaneHandleResolver';
import { composePaneEnv } from '../tmux/hubPaneEnv';

// Drives a real agent process (started here, on a throwaway port and token) in front of a real misao daemon started in a
// throwaway directory (never the resident ~/.misao one). The hub side is the real driver stack over the agent's relay.
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const SOCKET_BYTES_MAX = 107;
const AGENT_MAIN = path.resolve(__dirname, '../../agent/main.ts');
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const HUB_ENV = { publicUrl: 'http://hub.example:3001', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh-token-secret' };
const DAEMON_LEAK = 'daemon-inherited-secret';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function wsStatus(url: string, headers: Record<string, string> = {}): Promise<{ status?: number; opened: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => { resolve({ status: res.statusCode, opened: false }); ws.terminate(); });
    ws.once('open', () => { resolve({ opened: true }); ws.close(); });
    ws.once('error', () => undefined);
  });
}

describe.skipIf(!fs.existsSync(MISAO_CLI))('an agent server\'s misao, through the agent relay', () => {
  let dir: string;
  let daemon: ChildProcess;
  let agent: ChildProcess;
  let agentLog = '';
  let port: number;
  const token = crypto.randomBytes(16).toString('hex');
  const warn = vi.fn();
  let misao: MisaoHandle;
  let registry: MuxDriverRegistry;
  let transportFactory: TransportFactory;
  let server: ServerConfig;
  const windows: Window[] = [];
  const recorded: Array<{ serverName: string; target: string; status: string }> = [];
  let paneStates: MisaoPaneStateEvents;

  const driver = () => registry.resolveKind('misao', server);

  /** Runs `command` in a new misao window of the agent server and returns where it is. */
  async function openWindow(command: string, srv: ServerConfig = server): Promise<{ ref: MuxRef; pane: PaneHandle }> {
    const name = `w${Math.random().toString(36).slice(2, 7)}`;
    const opened = await registry.resolveKind('misao', srv).openWorkspace(srv, `azr-${name}`, { windowName: name, exactName: true, command });
    const pane = await registry.resolveKind('misao', srv).resolvePane(srv, opened.ref, 1);
    return { ref: opened.ref, pane };
  }

  async function screenOf(pane: PaneHandle, srv: ServerConfig = server): Promise<string> {
    return (await registry.resolveKind('misao', srv).captureScreen(srv, pane)).stdout;
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azr-'));
    const socketPath = path.join(dir, 'm.sock');
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(SOCKET_BYTES_MAX);
    // The daemon inherits a "secret" the way a daemon started from the agent's environment would.
    daemon = spawn(process.execPath, [MISAO_CLI, 'serve', '--socket', socketPath, '--data', dir], {
      stdio: 'ignore',
      env: { ...process.env, AZITO_AGENT_TOKEN: DAEMON_LEAK, AZITO_UI_TOKEN: DAEMON_LEAK, AZITO_WEBHOOK_TOKEN: DAEMON_LEAK },
    });
    await vi.waitFor(() => expect(fs.existsSync(socketPath)).toBe(true), { timeout: 10000, interval: 50 });

    port = await freePort();
    const agentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AZITO_AGENT_BIND: '127.0.0.1',
      AZITO_AGENT_TOKEN: token,
      PORT: String(port),
      MISAO_SOCKET: socketPath,
      HOME: path.join(dir, 'home'),
      // The agent installs tmux hooks: keep it away from any tmux server of the developer's.
      TMUX_TMPDIR: path.join(dir, 'tmux'),
    };
    delete agentEnv.TMUX;
    fs.mkdirSync(agentEnv.HOME!, { recursive: true });
    fs.mkdirSync(agentEnv.TMUX_TMPDIR!, { recursive: true });
    agent = spawn(process.execPath, [TSX_CLI, AGENT_MAIN], { env: agentEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../../..') });
    agent.stdout?.on('data', (chunk: Buffer) => { agentLog += chunk.toString(); });
    agent.stderr?.on('data', (chunk: Buffer) => { agentLog += chunk.toString(); });
    await vi.waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      expect(res?.ok, agentLog).toBe(true);
    }, { timeout: 30000, interval: 200 });

    server = { name: 'agent1', type: 'agent', host: '127.0.0.1', agentPort: port, agentToken: token, defaultMux: 'misao', muxRuntime: 'system', isolationIntent: false } as ServerConfig;
    transportFactory = new TransportFactory(HUB_ENV.publicUrl);
    registry = new MuxDriverRegistry();
    const sdk = await import('@misao/sdk');
    misao = registerMisaoDriver(registry, { sdk, socketPath: path.join(dir, 'unused-local.sock'), shell: '/bin/bash' }, () => undefined, { warn }, HUB_ENV, {
      target: (srv) => ({ connect: ({ signal }) => transportFactory.getAgentTransport(srv).connectMisaoRelay(signal) }),
      status: (srv) => transportFactory.getAgentTransport(srv).fetchMisaoStatus(),
      latest: () => server,
    });

    expect(await misao.servers.discoverAgentNode(server)).toBe(true);
    const node = misao.servers.nodeFor(server);
    await vi.waitFor(() => expect(node.connection.availability()).toEqual({ available: true }), { timeout: 15000, interval: 100 });

    const windowRepo = {
      findAll: () => windows,
      findById: (id: number) => windows.find((w) => w.id === id),
      findByServerAndRef: (serverName: string, ref: MuxRef) => windows.find((w) => w.serverName === serverName && w.muxRef?.window === ref.window),
    } as unknown as IWindowRepository;
    const serverRepo = { findByName: (name: string) => (name === server.name ? server : null), findAll: () => [server] } as unknown as IServerRepository;
    const bridge = new MisaoActivityBridge({
      resolver: new PaneHandleResolver(registry, windowRepo, serverRepo),
      findWindowByRef: (serverName, ref) => windowRepo.findByServerAndRef(serverName, ref),
      monitor: { recordMuxSignal: (serverName, target, status) => { recorded.push({ serverName, target, status }); } },
      listServerNames: () => [server.name],
      log: { warn },
    });
    paneStates = new MisaoPaneStateEvents(node.connection, bridge, { warn });
    await paneStates.start();
  }, 90000);

  afterAll(async () => {
    paneStates?.stop();
    misao?.servers.closeAgentNodes();
    misao?.connection.close();
    for (const child of [agent, daemon]) {
      if (child && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('the relay is the agent\'s and answers to the agent\'s token only', () => {
    it('refuses a WebSocket without the token, with a wrong one, and a plain request without it', async () => {
      const url = `ws://127.0.0.1:${port}/ws?mode=misao`;
      expect(await wsStatus(url)).toEqual({ status: 401, opened: false });
      expect(await wsStatus(url, { authorization: 'Bearer not-the-token' })).toEqual({ status: 401, opened: false });
      expect(await wsStatus(url, { authorization: token })).toEqual({ status: 401, opened: false });
      for (const route of ['/api/misao/status', '/api/exec']) {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: route === '/api/exec' ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: route === '/api/exec' ? JSON.stringify({ command: 'id' }) : undefined });
        expect(res.status, route).toBe(401);
      }
      expect(await wsStatus(url, { authorization: `Bearer ${token}` })).toEqual({ opened: true });
    });

    it('always reaches the agent\'s own socket: a path or socket in the query changes nothing', async () => {
      const decoy = path.join(dir, 'decoy.sock');
      const decoyServer = net.createServer((conn) => conn.end('decoy answered\n'));
      await new Promise<void>((resolve) => decoyServer.listen(decoy, resolve));
      try {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?mode=misao&path=${encodeURIComponent(decoy)}&socket=${encodeURIComponent(decoy)}&MISAO_SOCKET=${encodeURIComponent(decoy)}`, { headers: { authorization: `Bearer ${token}` } });
        const answer = await new Promise<string>((resolve, reject) => {
          ws.once('open', () => ws.send('{"jsonrpc":"2.0","id":1,"method":"server.info","params":{}}\n'));
          ws.on('message', (data: Buffer) => resolve(data.toString()));
          ws.once('error', reject);
          setTimeout(() => reject(new Error('no answer')), 10000);
        });
        expect(answer).toContain('protocolVersion');
        expect(answer).not.toContain('decoy answered');
        ws.close();
      } finally {
        await new Promise<void>((resolve) => decoyServer.close(() => resolve()));
      }
    });

    it('reports the socket and the host on the status route', async () => {
      const status = await (transportFactory.getTransport(server) as AgentTransport).fetchMisaoStatus();
      expect(status).toMatchObject({ socketPath: path.join(dir, 'm.sock'), socketPresent: true, host: { platform: process.platform, arch: process.arch } });
    });
  });

  describe('windows through the relay', () => {
    it('creates a window, runs a command in it, lists it and reads its screen', async () => {
      const { ref, pane } = await openWindow('echo relayed-output-1; sleep 30');
      await vi.waitFor(async () => expect(await screenOf(pane)).toContain('relayed-output-1'), { timeout: 15000, interval: 200 });
      const listed = await driver().listWorkspaces(server);
      expect(listed.flatMap((w) => w.windows).some((w) => (w as { ref?: MuxRef }).ref?.window === ref.window)).toBe(true);
      expect(await driver().windowExists(server, ref)).toBe(true);
    });

    it('attaches a terminal: output arrives and typed input reaches the pane', async () => {
      const { ref, pane } = await openWindow('cat');
      const stream = await driver().openTerminal(server, ref, 1, 80, 24);
      let received = '';
      stream.on('data', (chunk: string) => { received += chunk; });
      stream.write('hello-through-relay\r');
      await vi.waitFor(() => expect(received).toContain('hello-through-relay'), { timeout: 15000, interval: 100 });
      expect(await screenOf(pane)).toContain('hello-through-relay');
      stream.close();
    });

    it('reads a task\'s output lines through its own server\'s connection, with the done marker detected', async () => {
      const { pane } = await openWindow('sleep 2; echo AZITO_DONE_7_abc; sleep 30');
      const factory = new PaneStreamFactory(transportFactory, (srv) => misao.servers.nodeFor(srv).connection);
      const stream = factory.create('7-123', server, pane);
      stream.setMarkers('AZITO_DONE_7_abc', 'AZITO_QUESTIONS_7_abc');
      stream.enableMarkerDetection();
      const detected = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('marker not detected')), 20000);
        stream.on('marker', (kind: string) => { clearTimeout(timer); resolve(kind); });
      });
      stream.start();
      try {
        expect(await detected).toBeTruthy();
        expect(stream.getBuffer()).toContain('AZITO_DONE_7_abc');
      } finally {
        stream.stop();
      }
    });

    it('takes the completion signal file of a remote task from the agent (file-tail), not from the hub\'s own disk', () => {
      const factory = new PaneStreamFactory(transportFactory, () => { throw new Error('no misao lines for a signal stream'); });
      const signal = factory.create('7-sig', server);
      expect(signal.constructor.name).toBe('AgentPaneStream');
    });
  });

  describe('activity detection through the relay', () => {
    it('attributes a pane state of the agent server\'s daemon to its window row', async () => {
      const name = `act${Math.random().toString(36).slice(2, 6)}`;
      const opened = await driver().openWorkspace(server, `azr-${name}`, { windowName: name, exactName: true, command: 'echo done-quickly' });
      windows.push({
        id: windows.length + 1, ownerType: 'project', projectId: 1, taskId: null, serverName: server.name, tmuxTarget: opened.ref.window,
        label: name, isPrimary: false, windowType: 'agent', workerType: 'claude', workerModel: null, agentSessionId: null,
        launchCommand: null, workingDirectory: null, paneLayout: null, sleeping: false, createdAt: '2026-01-01T00:00:00Z', muxRef: opened.ref,
      });
      // The command ends at once: the daemon reports `exited`, which the hub reads as done, for the row of THIS server.
      await vi.waitFor(() => expect(recorded.some((r) => r.serverName === 'agent1' && r.target === opened.ref.window && r.status === 'done')).toBe(true), { timeout: 25000, interval: 200 });
    });
  });

  describe('isolation: the credential mask holds for a misao window of an isolated agent server', () => {
    const secrets = (screen: string) => [DAEMON_LEAK, HUB_ENV.webhookToken, token].filter((s) => screen.includes(s));

    it('blanks the credentials the daemon inherited and does not hand the hub\'s webhook token to the pane', async () => {
      const isolated = { ...server, isolationIntent: true } as ServerConfig;
      const { pane } = await openWindow('printenv AZITO_AGENT_TOKEN AZITO_UI_TOKEN AZITO_WEBHOOK_TOKEN AZITO_URL; echo ISO-ENV-END; sleep 30', isolated);
      await vi.waitFor(async () => expect(await screenOf(pane, isolated)).toContain('ISO-ENV-END'), { timeout: 15000, interval: 200 });
      const screen = await screenOf(pane, isolated);
      expect(secrets(screen)).toEqual([]);
      expect(screen).toContain(HUB_ENV.publicUrl);
    });

    it('is the same rule the pane env composer states, for an isolated server of either type', () => {
      const env = composePaneEnv(HUB_ENV, { type: 'agent', isolationIntent: true }, undefined);
      expect(env).toMatchObject({ AZITO_AGENT_TOKEN: '', AZITO_UI_TOKEN: '', AZITO_WEBHOOK_TOKEN: '', AZITO_URL: HUB_ENV.publicUrl });
    });

    it('control: a non-isolated server\'s pane does get the webhook token (and shows the daemon\'s own env through)', async () => {
      const { pane } = await openWindow('printenv AZITO_WEBHOOK_TOKEN AZITO_AGENT_TOKEN; echo OPEN-ENV-END; sleep 30');
      await vi.waitFor(async () => expect(await screenOf(pane)).toContain('OPEN-ENV-END'), { timeout: 15000, interval: 200 });
      const screen = await screenOf(pane);
      expect(screen).toContain(HUB_ENV.webhookToken);
      expect(screen).not.toContain(token);
    });

    it('does not persist the hub\'s webhook token in what the daemon shows for the pane (it is passed as ephemeral env)', async () => {
      const { pane } = await openWindow('sleep 30');
      const info = await misao.servers.nodeFor(server).connection.request('pane.info', { paneId: pane });
      expect(JSON.stringify(info)).not.toContain(HUB_ENV.webhookToken);
    });
  });

  describe('the node of a server follows the server', () => {
    it('lists misao for the server only while it has a node, and says not_installed after the node is dropped', async () => {
      expect(registry.supportedKinds({ ...server, defaultMux: 'tmux' })).toContain('misao');
      misao.servers.discardAgentNode(server);
      expect(registry.availabilityFor('misao', server)).toEqual({ available: false, reason: 'not_installed' });
      expect(registry.supportedKinds({ ...server, defaultMux: 'tmux' })).not.toContain('misao');
      expect(() => driver()).toThrow(MuxDriverUnavailableError);
      // The agent and its daemon are untouched: a new node connects again.
      misao.servers.ensureAgentNode(server);
      await vi.waitFor(() => expect(registry.availabilityFor('misao', server)).toEqual({ available: true }), { timeout: 15000, interval: 100 });
    });
  });

  it('keeps the agent healthy through all of the above', () => {
    expect(agent.exitCode, agentLog).toBeNull();
    expect(asPaneHandle('p_x')).toBeTruthy();
  });
});
