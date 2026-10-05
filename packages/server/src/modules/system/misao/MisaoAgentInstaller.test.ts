import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import misaoRoutes from '../../../agent/misaoRoutes';
import { agentMisaoManagedSocket, readMisaoSocketStatus, type AgentMisaoHost } from '../../servers/transport/agentMisaoSocket';
import { readMisaoBundle, type MisaoBundle } from './MisaoBundle';
import { MisaoAgentInstaller, type MisaoInstallTarget } from './MisaoAgentInstaller';
import { MisaoServiceError } from './MisaoServiceError';

const REPO_DEPLOY_DIR = path.resolve(__dirname, '../../../../../../deploy');
const VERSION = '0.2.0';

/** A "daemon": listens on --socket until it is killed. Stands in for misao.mjs, which this test does not need to run for real. */
const FAKE_DAEMON = `
import net from 'net'; import fs from 'fs';
const args = process.argv.slice(2);
const socket = args[args.indexOf('--socket') + 1];
fs.rmSync(socket, { force: true });
net.createServer().listen(socket);
`;

/** The same, as CommonJS, for `node -e`. */
const FAKE_DAEMON_CJS = FAKE_DAEMON.replace("import net from 'net'; import fs from 'fs';", "const net = require('net'); const fs = require('fs');").replace(/\n/g, ' ');

function sha(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function writeHubBundle(root: string): void {
  fs.mkdirSync(path.join(root, 'misao'), { recursive: true });
  fs.writeFileSync(path.join(root, 'misao', 'misao.mjs'), FAKE_DAEMON);
  fs.writeFileSync(path.join(root, 'misao', 'LICENSES.txt'), 'licenses\n');
  fs.writeFileSync(path.join(root, 'misao', 'manifest.json'), JSON.stringify({ version: VERSION, files: { 'misao.mjs': sha(FAKE_DAEMON), 'LICENSES.txt': sha('licenses\n') } }));
  fs.mkdirSync(path.join(root, 'node_modules', 'node-pty'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'node-pty', 'package.json'), '{"name":"node-pty"}');
  fs.cpSync(REPO_DEPLOY_DIR, path.join(root, 'deploy'), { recursive: true });
}

function runShell(script: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { env, timeout: 30_000 }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      resolve({ stdout, stderr, code: err ? (typeof raw === 'number' ? raw : 1) : 0 });
    });
  });
}

describe('MisaoAgentInstaller (against a sandboxed agent host)', () => {
  let tmp: string;
  let home: string;
  let app: FastifyInstance;
  let host: AgentMisaoHost;
  let bundle: MisaoBundle;
  let systemctlLog: string;
  const daemons: number[] = [];

  /** `systemctl` as a script on PATH: this test must never talk to the developer's real user manager. */
  function installFakeSystemctl(mode: 'absent' | 'ok'): void {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const script = mode === 'absent'
      ? '#!/bin/sh\necho "Failed to connect to bus" >&2\nexit 1\n'
      : `#!/bin/sh\necho "$@" >> ${systemctlLog}\nif [ "$2" = start ]; then\n  UNIT="${home}/.config/systemd/user/azito-misao.service"\n  EXEC=$(sed -n 's/^ExecStart=//p' "$UNIT")\n  setsid sh -c "$EXEC" >/dev/null 2>&1 < /dev/null &\nfi\nexit 0\n`;
    fs.writeFileSync(path.join(bin, 'systemctl'), script, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'loginctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  function target(overrides: Partial<MisaoInstallTarget> = {}): MisaoInstallTarget {
    const env = { PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, HOME: home };
    return {
      exec: (command) => runShell(command, env),
      fetchMisaoStatus: async () => {
        const res = await app.inject({ method: 'GET', url: '/api/misao/status' });
        return res.json();
      },
      uploadMisaoFile: async (version, name, data) => {
        const res = await app.inject({ method: 'PUT', url: `/api/misao/upload?version=${version}&name=${name}`, headers: { 'content-type': 'application/octet-stream' }, payload: data });
        if (res.statusCode !== 200) throw new Error(`upload ${res.statusCode}: ${res.body}`);
        return res.json();
      },
      ...overrides,
    } as MisaoInstallTarget;
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azmi-'));
    home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    systemctlLog = path.join(tmp, 'systemctl.log');
    writeHubBundle(path.join(tmp, 'hub'));
    bundle = readMisaoBundle(path.join(tmp, 'hub'))!;
    const nodePtyDir = path.join(tmp, 'agent-node-pty');
    fs.mkdirSync(nodePtyDir, { recursive: true });
    fs.writeFileSync(path.join(nodePtyDir, 'package.json'), '{"name":"node-pty"}');
    host = { homeDir: home, nodePath: process.execPath, servicePath: '/usr/bin:/bin', nodePtyDir, platform: 'linux', arch: 'x64' };
    app = Fastify();
    await app.register(misaoRoutes, { socket: { path: agentMisaoManagedSocket(home) }, host });
    await app.ready();
  });

  afterEach(async () => {
    for (const pid of daemons.splice(0)) { try { process.kill(pid); } catch { /* already gone */ } }
    // Daemons started by the installer (nohup / the fake systemctl) are found by their socket path, which is unique to this run.
    await runShell(`pkill -f -- ${JSON.stringify(path.join(home, '.azito', 'misao', 'misao.sock'))} || true`, process.env);
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const installer = (b: MisaoBundle | null = bundle) => new MisaoAgentInstaller(b, { readyTimeoutMs: 8_000, pollIntervalMs: 50 });

  it('puts the bundled release on the host, runs it as a background process when there is no user systemd, and a second install changes nothing', async () => {
    installFakeSystemctl('absent');
    const progress: string[] = [];
    const result = await installer().install(target(), (m) => progress.push(m));

    expect(result).toEqual({ version: VERSION, runningVersion: VERSION, startMethod: 'nohup', updateAvailable: false });
    const root = path.join(home, '.azito', 'misao');
    expect(fs.readFileSync(path.join(root, VERSION, 'misao.mjs'), 'utf-8')).toBe(FAKE_DAEMON);
    expect(fs.readFileSync(path.join(root, VERSION, 'LICENSES.txt'), 'utf-8')).toBe('licenses\n');
    expect(fs.existsSync(path.join(root, VERSION, 'node_modules', 'node-pty', 'package.json'))).toBe(true);
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe(VERSION);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(root, `${VERSION}.upload`))).toBe(false);
    expect(readMisaoSocketStatus({ path: agentMisaoManagedSocket(home) }, host)).toMatchObject({ socketPresent: true, installedVersion: VERSION });
    expect(progress).toEqual(['Inspecting the agent host', 'Transferring misao', 'Preparing misao', 'Starting misao']);

    // Already running the bundled release: nothing is transferred, started or switched.
    const upload = vi.fn();
    const again = await installer().install(target({ uploadMisaoFile: upload }));
    expect(again).toEqual({ version: VERSION, runningVersion: VERSION, startMethod: 'running', updateAvailable: false });
    expect(upload).not.toHaveBeenCalled();
  });

  it('writes the systemd unit with the agent\'s node and starts it through systemctl --user', async () => {
    installFakeSystemctl('ok');
    const result = await installer().install(target());

    expect(result.startMethod).toBe('systemd');
    const unit = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'azito-misao.service'), 'utf-8');
    const root = path.join(home, '.azito');
    expect(unit).toContain(`ExecStart=${process.execPath} ${root}/misao/current/misao.mjs serve --socket ${root}/misao/misao.sock --data ${root}/misao`);
    expect(unit).toContain('Environment=PATH=/usr/bin:/bin');
    expect(unit).toContain('KillMode=process');
    expect(unit).not.toContain('__');
    expect(fs.readFileSync(systemctlLog, 'utf-8')).toBe('--user daemon-reload\n--user enable azito-misao\n--user start azito-misao\n');
  });

  it('starts the background process with a cleared environment, so nothing of the agent reaches its panes', async () => {
    installFakeSystemctl('absent');
    const exec = vi.fn(target().exec);
    // The agent's own secrets are in the environment the exec runs in; the daemon must not see them.
    const env = { PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`, HOME: home, AZITO_AGENT_TOKEN: 'agent-secret', AZITO_WEBHOOK_TOKEN: 'hook-secret' };
    exec.mockImplementation((command) => runShell(command, env));
    await installer().install(target({ exec }));

    const socket = agentMisaoManagedSocket(home);
    const { stdout } = await runShell(`pid=$(pgrep -f -- ${JSON.stringify(socket)} | head -1); tr '\\0' '\\n' < /proc/$pid/environ`, process.env);
    expect(stdout).toContain(`HOME=${home}`);
    expect(stdout).not.toContain('agent-secret');
    expect(stdout).not.toContain('hook-secret');
    expect(stdout).not.toContain('AZITO_AGENT_TOKEN');
  });

  it('leaves a running older release alone and reports the update that is left to do', async () => {
    installFakeSystemctl('absent');
    const root = path.join(home, '.azito', 'misao');
    fs.mkdirSync(path.join(root, '0.1.0'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, '0.1.0', 'misao.mjs'), FAKE_DAEMON);
    fs.symlinkSync('0.1.0', path.join(root, 'current'));
    const old = await runShell(`setsid ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, '0.1.0', 'misao.mjs'))} serve --socket ${JSON.stringify(agentMisaoManagedSocket(home))} --data ${JSON.stringify(root)} >/dev/null 2>&1 < /dev/null & echo $!`, process.env);
    daemons.push(Number(old.stdout.trim()));
    await vi.waitFor(() => expect(fs.existsSync(agentMisaoManagedSocket(home))).toBe(true), { timeout: 5000 });

    const result = await installer().install(target());

    expect(result).toEqual({ version: VERSION, runningVersion: '0.1.0', startMethod: 'running', updateAvailable: true });
    expect(fs.readlinkSync(path.join(root, 'current'))).toBe('0.1.0');
    expect(fs.existsSync(path.join(root, VERSION, 'misao.mjs'))).toBe(true);
  });

  it('refuses a daemon AZITO did not install, and starts nothing', async () => {
    installFakeSystemctl('absent');
    const root = path.join(home, '.azito', 'misao');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const foreign = await runShell(`setsid ${JSON.stringify(process.execPath)} -e ${JSON.stringify(FAKE_DAEMON_CJS)} serve --socket ${JSON.stringify(agentMisaoManagedSocket(home))} >/dev/null 2>&1 < /dev/null & echo $!`, process.env);
    daemons.push(Number(foreign.stdout.trim()));
    await vi.waitFor(() => expect(fs.existsSync(agentMisaoManagedSocket(home))).toBe(true), { timeout: 5000 });

    await expect(installer().install(target())).rejects.toMatchObject({ code: 'custom_socket' });
    expect(fs.existsSync(path.join(root, VERSION))).toBe(false);
  });

  it('refuses when the agent relays to a socket other than the managed one', async () => {
    installFakeSystemctl('absent');
    const status = { ...(await target().fetchMisaoStatus()), socketPath: '/run/user/1000/other.sock' };
    await expect(installer().install(target({ fetchMisaoStatus: async () => status }))).rejects.toMatchObject({ code: 'custom_socket' });
  });

  it.each([
    ['not Linux', { platform: 'darwin' as const }],
    ['not x86_64', { arch: 'arm64' }],
    ['without node-pty', { nodePtyDir: null }],
    ['with a node path that cannot go in a unit', { nodePath: '/opt/my node/bin/node' }],
  ])('refuses an agent host %s', async (_label, change) => {
    installFakeSystemctl('absent');
    const status = { ...(await target().fetchMisaoStatus()) };
    status.host = { ...status.host, ...change };
    await expect(installer().install(target({ fetchMisaoStatus: async () => status }))).rejects.toMatchObject({ code: 'unsupported_host' });
  });

  it('says to update the agent when it has no misao status route', async () => {
    installFakeSystemctl('absent');
    const old = target({ fetchMisaoStatus: async () => { throw new Error('Agent /api/misao/status failed (404)'); } });
    await expect(installer().install(old)).rejects.toMatchObject({ code: 'unsupported_host', message: expect.stringContaining('update the agent') });
  });

  it('refuses without a bundled misao', async () => {
    await expect(installer(null).install(target())).rejects.toMatchObject({ code: 'not_managed' });
  });

  it('rejects a file that arrives damaged and does not prepare the release', async () => {
    installFakeSystemctl('absent');
    const damaged = target({ uploadMisaoFile: async (_v, name) => ({ name, size: 1, sha256: 'f'.repeat(64) }) });
    const error = await installer().install(damaged).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MisaoServiceError);
    expect((error as MisaoServiceError).code).toBe('transfer_failed');
    expect(fs.existsSync(path.join(home, '.azito', 'misao', VERSION))).toBe(false);
  });

  it('refuses to send a bundled file that changed on disk after the bundle was read', async () => {
    installFakeSystemctl('absent');
    fs.writeFileSync(bundle.files['misao.mjs'], '// tampered\n');
    const upload = vi.fn();
    await expect(installer().install(target({ uploadMisaoFile: upload }))).rejects.toMatchObject({ code: 'transfer_failed' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('transfers again when the version directory on the host is damaged', async () => {
    installFakeSystemctl('absent');
    const root = path.join(home, '.azito', 'misao');
    fs.mkdirSync(path.join(root, VERSION, 'node_modules', 'node-pty'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, VERSION, 'node_modules', 'node-pty', 'package.json'), '{}');
    fs.writeFileSync(path.join(root, VERSION, 'misao.mjs'), '// not the bundled file\n');
    const upload = vi.fn(target().uploadMisaoFile);
    await installer().install(target({ uploadMisaoFile: upload }));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(root, VERSION, 'misao.mjs'), 'utf-8')).toBe(FAKE_DAEMON);
  });
});
