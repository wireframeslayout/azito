import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import serversRoutes from './routes';
import type { ServersRouteOptions } from './routes';
import type { IServerRepository, ServerConfig } from './Server';
import type { HostProfile } from '../../shared/os/hostProfile';
import type { CommandSpec } from '../../shared/exec/commandSpec';
import { KeyedMutex } from '../../shared/keyedMutex';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { AgentUnreachableError } from './transport/AgentUnreachableError';
import { argvOfShellLine, argvOfSpec, failed, ok } from '../../shared/exec/testing/commandTesting';

const server = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  name: 'srv', type: 'agent', host: '100.64.0.7', agentPort: 3002, agentToken: 'tok', agentVersion: 'v1', sshHost: null,
  hostProfile: null, sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null,
  isolationCleanupReport: null, defaultMux: 'tmux', muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z', ...overrides,
});

interface Setup {
  specs: CommandSpec[];
  execCommands: string[];
  fetchHealth: ReturnType<typeof vi.fn>;
  app: ReturnType<typeof Fastify>;
}

async function build(stored: ServerConfig, profile: HostProfile | null, onRun: (spec: CommandSpec) => ReturnType<typeof ok> = () => ok()): Promise<Setup> {
  const specs: CommandSpec[] = [];
  const execCommands: string[] = [];
  const fetchHealth = vi.fn(async () => ({ version: 'v1' }));
  const transport = {
    run: async (spec: CommandSpec) => { specs.push(spec); return onRun(spec); },
    exec: async (command: string) => { execCommands.push(command); return { stdout: '', stderr: '', code: 0 }; },
    execMux: async () => ({ stdout: 'tmux 3.4\n', stderr: '', code: 0 }),
    fetchHealth,
    files: () => ({ platform: 'linux', realpath: async (p: string) => (p.startsWith('~/') ? `/home/u${p.slice(1)}` : p) }),
  };
  const opts: ServersRouteOptions = {
    serverRepo: { findByName: () => stored, findAll: () => [stored] } as unknown as IServerRepository,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    agentHostRecorder: { recordIfUnknown: vi.fn(async () => null), record: vi.fn(async () => null), forget: vi.fn() } as unknown as ServersRouteOptions['agentHostRecorder'],
    tmux: {} as ServersRouteOptions['tmux'],
    transportFactory: {
      invalidate: vi.fn(),
      hostProfileFor: () => profile,
      getTransport: () => transport,
      getAgentTransport: () => transport,
    } as unknown as ServersRouteOptions['transportFactory'],
    windowRepo: { findByServer: vi.fn(() => []) } as unknown as ServersRouteOptions['windowRepo'],
    projectRepo: {} as ServersRouteOptions['projectRepo'],
    projectServerRepo: { find: () => ({ workingDirectory: '/work' }) } as unknown as ServersRouteOptions['projectServerRepo'],
    webhookToken: 'wh',
    uiToken: 'ui',
    harnessHash: 'testhash',
    harnessUpdater: { getLastResult: vi.fn() } as unknown as ServersRouteOptions['harnessUpdater'],
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry: new MuxDriverRegistry(),
    misaoDaemonStatus: vi.fn(async () => ({ installed: false })),
  };
  const app = Fastify();
  await app.register(serversRoutes, opts);
  return { specs, execCommands, fetchHealth, app };
}

describe('GET /api/servers/:name/install-status probes', () => {
  it('runs node and tailscale as programs with arguments and reads their output', async () => {
    const { app, specs } = await build(server(), { platform: 'linux', arch: 'x64' }, (spec) => {
      if (spec.file === 'node') return ok('v24.14.0\n');
      if (spec.file === 'tailscale') return ok('100.64.0.7\n');
      return ok();
    });
    const body = (await app.inject({ method: 'GET', url: '/api/servers/srv/install-status' })).json();

    expect(body.node).toMatchObject({ installed: true, version: 'v24.14.0' });
    expect(body.tailscale).toMatchObject({ installed: true, version: '100.64.0.7' });
    expect(specs.find((s) => s.file === 'node')!.args).toEqual(['--version']);
    expect(specs.find((s) => s.file === 'tailscale')!.args).toEqual(['ip', '-4']);
  });

  it.skipIf(process.platform === 'win32')('runs the same argv as the old shell strings', async () => {
    const { app, specs } = await build(server(), { platform: 'linux', arch: 'x64' });
    await app.inject({ method: 'GET', url: '/api/servers/srv/install-status' });
    expect(specs.filter((s) => s.file === 'node' || s.file === 'tailscale').map(argvOfSpec)).toEqual(
      ['node --version', 'tailscale ip -4'].map(argvOfShellLine),
    );
  });

  it('reads a missing tailscale (non-zero exit) as not configured', async () => {
    const { app } = await build(server(), { platform: 'linux', arch: 'x64' }, (spec) => (spec.file === 'tailscale' ? failed(1, 'not found') : ok('v24.0.0')));
    const body = (await app.inject({ method: 'GET', url: '/api/servers/srv/install-status' })).json();
    expect(body.tailscale).toEqual({ installed: false, detail: 'tailscale not configured' });
  });

  it('does not probe the OS when the host is recorded', async () => {
    const { app, specs } = await build(server(), { platform: 'darwin', arch: 'arm64' });
    await app.inject({ method: 'GET', url: '/api/servers/srv/install-status' });
    expect(specs.some((s) => s.file === 'uname')).toBe(false);
  });

  it('still probes `uname -s` for an agent whose host was never recorded (a Unix one)', async () => {
    const { app, specs } = await build(server(), null, (spec) => (spec.file === 'uname' ? ok('Linux\n') : ok()));
    await app.inject({ method: 'GET', url: '/api/servers/srv/install-status' });
    expect(specs.filter((s) => s.file === 'uname').map((s) => s.args)).toEqual([['-s']]);
  });

  it('answers 503 for an unreachable agent, before building any row', async () => {
    const { app, fetchHealth, specs } = await build(server(), { platform: 'linux', arch: 'x64' });
    fetchHealth.mockRejectedValue(new AgentUnreachableError('srv', 'refused'));
    const res = await app.inject({ method: 'GET', url: '/api/servers/srv/install-status' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'agent_unreachable', server: 'srv', reason: 'refused' });
    expect(specs).toHaveLength(0);
  });
});

describe('GET /api/servers/:name/branches', () => {
  const url = '/api/servers/srv/branches?project_id=1';

  it('lists branches from git run in the working directory, without the remote prefix and HEAD', async () => {
    const { app, specs } = await build(server(), { platform: 'linux', arch: 'x64' }, () => ok('main\nfeature/x\norigin/HEAD\norigin/main\norigin/dev\n'));
    const body = (await app.inject({ method: 'GET', url })).json();
    expect(body).toEqual({ branches: ['main', 'feature/x', 'dev'] });
    expect(specs[0]).toMatchObject({ file: 'git', cwd: '/work', args: ['branch', '-a', '--format=%(refname:short)'] });
  });

  it('runs git in a working directory with spaces and Japanese characters', async () => {
    const { app, specs } = await build(server(), { platform: 'linux', arch: 'x64' }, () => ok('main\n'));
    const dir = '/home/u/my repo/日本語';
    const res = await app.inject({ method: 'GET', url: `/api/servers/srv/branches?working_directory=${encodeURIComponent(dir)}` });
    expect(res.json()).toEqual({ branches: ['main'] });
    expect(specs[0]).toMatchObject({ file: 'git', cwd: dir });
  });

  it('resolves a ~ working directory against the host home before running git', async () => {
    const { app, specs } = await build(server(), { platform: 'linux', arch: 'x64' }, () => ok('main\ndev\n'));
    const res = await app.inject({ method: 'GET', url: `/api/servers/srv/branches?working_directory=${encodeURIComponent('~/repo')}` });
    expect(res.json()).toEqual({ branches: ['main', 'dev'] });
    expect(specs[0]).toMatchObject({ file: 'git', cwd: '/home/u/repo' });
  });

  it('refuses a working_directory that is not a path of the host with 400, without running git', async () => {
    const { app, specs } = await build(server(), { platform: 'linux', arch: 'x64' });
    for (const dir of ['relative/dir', 'C:\\Users\\x y']) {
      const res = await app.inject({ method: 'GET', url: `/api/servers/srv/branches?working_directory=${encodeURIComponent(dir)}` });
      expect(res.statusCode, dir).toBe(400);
    }
    expect(specs).toHaveLength(0);
  });

  it('answers an empty list when git exits non-zero', async () => {
    const { app } = await build(server(), { platform: 'linux', arch: 'x64' }, () => failed(128, 'fatal: not a git repository', 'main\n'));
    expect((await app.inject({ method: 'GET', url })).json()).toEqual({ branches: [] });
  });

  it.skipIf(process.platform === 'win32')('runs the same argv as the old shell string', async () => {
    const { app, specs } = await build(server(), { platform: 'linux', arch: 'x64' }, () => ok('main\n'));
    await app.inject({ method: 'GET', url });
    expect(argvOfSpec(specs[0])).toEqual(argvOfShellLine("git branch -a --format='%(refname:short)'"));
  });
});
