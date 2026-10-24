import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import gitRoutes from './routes';
import type { GitRouteOptions } from './routes';
import serversRoutes from '../servers/routes';
import type { ServersRouteOptions } from '../servers/routes';
import { LocalTransport } from '../servers/transport/LocalTransport';
import type { ServerConfig } from '../servers/Server';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { resolveCurrentHostEnv } from '../../shared/os/hostEnv';
import { toHostProfile } from '../../shared/os/hostProfile';
import { KeyedMutex } from '../../shared/keyedMutex';
import { mapAppError } from '../../app/mapAppError';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { RepoDiscoveryService } from './RepoDiscoveryService';
import { RemoteWorktreeService } from './RemoteWorktreeService';
import type { WorktreeServiceFactory } from './WorktreeServiceFactory';

/**
 * The hub routes that run git, end to end with a real git on the machine the test runs on (Git for Windows on the Windows CI
 * runner, found by `GitLocator`): diff, commits, worktrees, branches and repository discovery, on a repository in a directory
 * with a space and Japanese characters.
 */
const hostEnv = resolveCurrentHostEnv();
const profile = toHostProfile(hostEnv.platform, hostEnv.arch);
const transport = new LocalTransport({ bin: 'tmux', baseArgs: [] } as never, 'http://hub', hostEnv, TaskTempFiles.fromHostEnv(hostEnv), profile);
const server = {
  name: 'local', type: 'local', host: null, agentPort: null, agentToken: null, agentVersion: null, sshHost: null, hostProfile: profile,
  sshHostFingerprint: null, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null,
  defaultMux: 'tmux', muxRuntime: 'system', createdAt: '2026-01-01T00:00:00Z',
} as unknown as ServerConfig;
const transportFactory = {
  getTransport: () => transport,
  hostProfileFor: () => profile,
  invalidate: vi.fn(),
};

let root: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf-8' }).trim();
}

async function buildApp() {
  const app = Fastify();
  const defaultHandler = app.errorHandler;
  app.setErrorHandler((err, request, reply) => {
    const mapped = mapAppError(err);
    if (mapped) return reply.status(mapped.status).send(mapped.body);
    return defaultHandler.call(app, err, request, reply);
  });
  const serverRepo = { findAll: () => [server], findByName: (name: string) => (name === 'local' ? server : null) };
  await app.register(gitRoutes, {
    serverRepo,
    transportFactory,
    taskRepo: { findById: () => null },
    projectServerRepo: { find: () => ({ workingDirectory: repo }) },
    worktreeServiceFactory: { create: (t: ConstructorParameters<typeof RemoteWorktreeService>[0]) => new RemoteWorktreeService(t) } as unknown as WorktreeServiceFactory,
  } as unknown as GitRouteOptions);
  const muxDriverRegistry = new MuxDriverRegistry();
  await app.register(serversRoutes, {
    serverRepo,
    serverAliasRepo: { resolve: (name: string) => name, findAll: () => [] },
    agentHostRecorder: { recordIfUnknown: vi.fn(async () => null), record: vi.fn(async () => null), forget: vi.fn() },
    tmux: {},
    transportFactory,
    windowRepo: { findByServer: vi.fn(() => []) },
    webhookToken: 'wh',
    uiToken: 'ui',
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    muxDriverRegistry,
    misaoDaemonStatus: vi.fn(async () => ({ installed: false })),
    repoDiscovery: new RepoDiscoveryService(transportFactory as never),
  } as unknown as ServersRouteOptions);
  return app;
}

beforeAll(() => {
  // realpath: a temp folder on macOS / a Windows short (8.3) name (RUNNER~1) would otherwise differ from what git prints.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'azito-gitroutes-')));
  repo = join(root, 'my repo 日本語');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'first');
  git(repo, 'checkout', '-q', '-b', 'feature/x');
  writeFileSync(join(repo, 'b.txt'), 'two\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'second 日本語');
  git(repo, 'remote', 'add', 'origin', 'https://example.com/acme/widgets.git');
  writeFileSync(join(repo, 'a.txt'), 'one\nchanged\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the hub routes that run git, through the real transport', () => {
  const q = (value: string): string => encodeURIComponent(value);

  it('GET /git/commits lists the commits after the base', async () => {
    const res = await (await buildApp()).inject({ method: 'GET', url: `/api/servers/local/git/commits?path=${q(repo)}&base=main` });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((c: { subject: string }) => c.subject)).toEqual(['second 日本語']);
  });

  it('GET /git/diff shows the uncommitted change', async () => {
    const res = await (await buildApp()).inject({ method: 'GET', url: `/api/servers/local/git/diff?path=${q(repo)}&scope=uncommitted` });
    expect(res.statusCode).toBe(200);
    expect(res.json().files.map((f: { file: string }) => f.file)).toEqual(['a.txt']);
  });

  it('GET /git/worktrees lists the main worktree in the host spelling', async () => {
    const res = await (await buildApp()).inject({ method: 'GET', url: '/api/servers/local/git/worktrees?project_id=1' });
    expect(res.statusCode).toBe(200);
    const worktrees = res.json().worktrees as Array<{ path: string; isMain: boolean }>;
    expect(worktrees.map((w) => w.path)).toEqual([repo]);
    expect(worktrees[0].isMain).toBe(true);
  });

  it('GET /branches searches the branches', async () => {
    const res = await (await buildApp()).inject({ method: 'GET', url: `/api/servers/local/branches?working_directory=${q(repo)}` });
    expect(res.statusCode).toBe(200);
    expect([...res.json().branches].sort()).toEqual(['feature/x', 'main']);
  });

  it('GET /discover-repositories finds the repository and its remote', async () => {
    const res = await (await buildApp()).inject({ method: 'GET', url: `/api/servers/local/discover-repositories?path=${q(root)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { exists: boolean; repositories: Array<{ relativePath: string; remotes: Array<{ url: string }> }> };
    expect(body.exists).toBe(true);
    expect(body.repositories.map((r) => r.relativePath)).toEqual(['my repo 日本語']);
    expect(body.repositories[0].remotes[0].url).toBe('https://example.com/acme/widgets.git');
  });
});
