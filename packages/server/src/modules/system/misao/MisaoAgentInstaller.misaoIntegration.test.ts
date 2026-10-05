import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerConfig } from '../../servers/Server';
import { TransportFactory } from '../../servers/transport/TransportFactory';
import type { AgentTransport } from '../../servers/transport/AgentTransport';
import { agentMisaoManagedSocket } from '../../servers/transport/agentMisaoSocket';
import { MuxDriverRegistry } from '../../tmux/MuxDriverRegistry';
import { describeMisaoDaemon, registerMisaoDriver, type MisaoHandle } from '../../tmux/misao/misaoDriver';
import { readMisaoBundle } from './MisaoBundle';
import { MisaoAgentInstaller } from './MisaoAgentInstaller';

// Installs the "bundled" misao on a real agent process (a throwaway port, token and HOME) the way the hub does, and then
// talks to the daemon it started through the relay. The bundle's misao.mjs only forwards to the built misao CLI of this
// machine, and no misao of the developer's (~/.misao) is touched.
const MISAO_CLI = process.env.MISAO_CLI ?? path.join(os.homedir(), 'workspace/misao/packages/cli/dist/main.js');
const AGENT_MAIN = path.resolve(__dirname, '../../../agent/main.ts');
const TSX_CLI = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const REPO_DEPLOY_DIR = path.resolve(__dirname, '../../../../../../deploy');
const HUB_ENV = { publicUrl: 'http://hub.example:3001', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh' };
const AGENT_SECRET_TOKEN = crypto.randomBytes(16).toString('hex');

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function sha(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function run(file: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, (err, stdout) => resolve({ stdout, code: err ? 1 : 0 }));
  });
}

describe.skipIf(!fs.existsSync(MISAO_CLI))('installing misao on a real agent process', () => {
  let dir: string;
  let home: string;
  let agent: ChildProcess;
  let agentLog = '';
  let port: number;
  let transport: AgentTransport;
  let misao: MisaoHandle | undefined;
  let server: ServerConfig;
  const warn = vi.fn();
  const socket = () => agentMisaoManagedSocket(home);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azi-'));
    home = path.join(dir, 'home');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(dir, 'tmux'), { recursive: true });
    // No user systemd for this agent (and the test must never reach the developer's own user manager).
    fs.writeFileSync(path.join(dir, 'bin', 'systemctl'), '#!/bin/sh\necho "Failed to connect to bus" >&2\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'bin', 'loginctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      AZITO_AGENT_BIND: '127.0.0.1',
      AZITO_AGENT_TOKEN: AGENT_SECRET_TOKEN,
      PORT: String(port),
      HOME: home,
      TMUX_TMPDIR: path.join(dir, 'tmux'),
    };
    delete env.TMUX;
    delete env.MISAO_SOCKET;
    agent = spawn(process.execPath, [TSX_CLI, AGENT_MAIN], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(__dirname, '../../../..') });
    agent.stdout?.on('data', (chunk: Buffer) => { agentLog += chunk.toString(); });
    agent.stderr?.on('data', (chunk: Buffer) => { agentLog += chunk.toString(); });
    await vi.waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      expect(res?.ok, agentLog).toBe(true);
    }, { timeout: 30000, interval: 200 });

    server = { name: 'agent2', type: 'agent', host: '127.0.0.1', agentPort: port, agentToken: AGENT_SECRET_TOKEN, defaultMux: 'misao', muxRuntime: 'system', isolationIntent: false } as ServerConfig;
    transport = new TransportFactory(HUB_ENV.publicUrl).getAgentTransport(server);
  }, 60000);

  afterAll(async () => {
    misao?.servers.closeAgentNodes();
    misao?.connection.close();
    // The daemon the installer started is found by its socket path, which is unique to this run.
    if (home) await run('pkill', ['-f', '--', socket()]);
    if (agent && agent.exitCode === null) {
      const exited = new Promise<void>((resolve) => agent.once('exit', () => resolve()));
      agent.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
      if (agent.exitCode === null) agent.kill('SIGKILL');
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('installs the bundled release through the agent, starts it with a clean environment, and the hub connects to it', async () => {
    const hub = path.join(dir, 'hub');
    const entry = `import '${MISAO_CLI}';\n`;
    fs.mkdirSync(path.join(hub, 'misao'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'misao', 'misao.mjs'), entry);
    fs.writeFileSync(path.join(hub, 'misao', 'LICENSES.txt'), 'licenses\n');
    fs.writeFileSync(path.join(hub, 'misao', 'manifest.json'), JSON.stringify({ version: '0.2.0', files: { 'misao.mjs': sha(entry), 'LICENSES.txt': sha('licenses\n') } }));
    fs.mkdirSync(path.join(hub, 'node_modules', 'node-pty'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'node_modules', 'node-pty', 'package.json'), '{"name":"node-pty"}');
    fs.cpSync(REPO_DEPLOY_DIR, path.join(hub, 'deploy'), { recursive: true });

    const steps: string[] = [];
    const result = await new MisaoAgentInstaller(readMisaoBundle(hub), { readyTimeoutMs: 20_000 }).install(transport, (step) => steps.push(step));

    expect(result).toEqual({ version: '0.2.0', runningVersion: '0.2.0', startMethod: 'nohup', updateAvailable: false });
    expect(steps).toEqual(['inspect', 'transfer', 'prepare', 'start']);
    const root = path.join(home, '.azito', 'misao');
    expect(fs.readFileSync(path.join(root, '0.2.0', 'misao.mjs'), 'utf-8')).toBe(entry);
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe('0.2.0');
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);

    // The daemon was started by the agent's exec, whose environment holds the agent token: none of it may reach the daemon (and so its panes).
    const pid = (await run('pgrep', ['-f', '--', socket()])).stdout.trim().split('\n')[0];
    const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf-8');
    expect(environ).toContain(`HOME=${home}`);
    expect(environ).not.toContain(AGENT_SECRET_TOKEN);
    expect(environ).not.toContain('AZITO_AGENT_TOKEN');

    // The hub reaches it through the relay (the agent was started without MISAO_SOCKET: the managed socket is its default).
    const registry = new MuxDriverRegistry();
    const sdk = await import('@misao/sdk');
    misao = registerMisaoDriver(registry, { sdk, socketPath: path.join(dir, 'unused-local.sock'), shell: '/bin/bash' }, () => undefined, { warn }, HUB_ENV, {
      target: (srv) => ({ connect: ({ signal }) => new TransportFactory(HUB_ENV.publicUrl).getAgentTransport(srv).connectMisaoRelay(signal) }),
      status: (srv) => new TransportFactory(HUB_ENV.publicUrl).getAgentTransport(srv).fetchMisaoStatus(),
    });
    const node = misao.servers.ensureAgentNode(server);
    await vi.waitFor(() => expect(node.connection.availability()).toEqual({ available: true }), { timeout: 15000, interval: 100 });
    expect(await describeMisaoDaemon(node.connection)).toMatchObject({ installed: true });
    expect(await transport.fetchMisaoStatus()).toMatchObject({ socketPresent: true, installedVersion: '0.2.0' });
  }, 90000);

  it('a second install leaves the running daemon alone', async () => {
    const hub = path.join(dir, 'hub');
    const before = (await run('pgrep', ['-f', '--', socket()])).stdout.trim();
    const result = await new MisaoAgentInstaller(readMisaoBundle(hub)).install(transport);
    expect(result.startMethod).toBe('running');
    expect((await run('pgrep', ['-f', '--', socket()])).stdout.trim()).toBe(before);
  }, 30000);
});
