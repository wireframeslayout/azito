import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';
import { TaskOriginationService } from '../tasks/origination/TaskOriginationService';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { KeyedMutex } from '../../shared/keyedMutex';

// Issue #19 third-party review:
// - Important finding 1: a discovered remote's raw URL (which may embed
//   credentials, `https://user:token@host/repo.git`) must never reach the
//   discover-repositories response, and the bulk-register endpoint must
//   refuse a credentialed URL outright.
// - Important finding 5: a scan the server could not actually run (a
//   transport/command failure) must surface as an error, never as an empty
//   "0 repositories found" success.

function makeOpts(overrides: Partial<ProjectsRouteOptions> = {}): ProjectsRouteOptions {
  const taskRepo: ProjectsRouteOptions['taskRepo'] = {
    findAll: vi.fn(() => []),
    findByProject: vi.fn(() => []),
    findByUnit: vi.fn(() => []),
    findByStatus: vi.fn(() => []),
    findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
    findById: vi.fn(() => null),
    create: vi.fn(() => 99),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updateCurrentPhase: vi.fn(),
    touch: vi.fn(),
    delete: vi.fn(),
    consumePendingApproval: vi.fn(() => false),
    recordExecutionGateBlock: vi.fn(() => true),
    preApproveExecution: vi.fn(() => true),
    countChildren: vi.fn(() => 0),
    countChildrenInGeneration: vi.fn(() => 0),
    clearTmuxWindowIfMatches: vi.fn(() => true),
    updateStatusIfWindowMatches: vi.fn(() => true),
  };
  const originationService = new TaskOriginationService(taskRepo, { record: vi.fn() } as unknown as AuditLogService);

  return {
    projectRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({
        id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
        sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, servers: [], repositories: [], windows: [],
        createdAt: '', updatedAt: '',
      })),
      create: vi.fn(() => 10),
      update: vi.fn(),
      delete: vi.fn(),
      addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => null),
      removeRepository: vi.fn(),
    },
    projectServerRepo: {
      findByProject: vi.fn(() => []),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 10, serverName: 'local', workingDirectory: '/work', branch: null, tmuxSession: '', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null })),
      upsert: vi.fn(),
      remove: vi.fn(),
    },
    taskRepo,
    originationService,
    gitProvider: {
      getIssue: vi.fn(async () => ({ number: 5, title: 'x', body: 'x', state: 'open', htmlUrl: 'https://github.com/acme/widgets/issues/5' })),
    } as unknown as ProjectsRouteOptions['gitProvider'],
    tmux: {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => {}),
    } as unknown as ProjectsRouteOptions['tmux'],
    serverRepo: {
      findAll: vi.fn(() => []),
      findByName: vi.fn(() => ({
        name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, agentVersion: null,
        sshHost: null, muxRuntime: 'system' as const, sshHostFingerprint: null,
        isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '',
      })),
      create: vi.fn(),
      update: vi.fn(),
      updateAgentVersion: vi.fn(),
      updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(),
      updateIsolationIntent: vi.fn(),
      delete: vi.fn(),
    },
    projectSecretRepo: {
      findByProject: vi.fn(() => []),
    } as unknown as ProjectsRouteOptions['projectSecretRepo'],
    serverIsolationMutex: new KeyedMutex(),
    repoDiscovery: { discover: vi.fn(async () => []) } as unknown as ProjectsRouteOptions['repoDiscovery'],
    ...overrides,
  };
}

describe('GET discover-repositories', () => {
  it('strips embedded credentials from a discovered remote URL before returning it', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'https://ghost:dummy-token@github.com/acme/widgets.git',
                parsed: { provider: 'github' as const, owner: 'acme', repoName: 'widgets', host: 'github.com' },
              },
            ],
          },
        ]),
      } as unknown as ProjectsRouteOptions['repoDiscovery'],
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/projects/10/servers/local/discover-repositories' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const url: string = body.repositories[0].remotes[0].url;
    expect(url).not.toContain('dummy-token');
    expect(url).not.toContain('ghost');
    expect(url).toBe('https://github.com/acme/widgets.git');
  });

  it('keeps a scp-like SSH remote URL (including its git user) unchanged', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'git@github.com:acme/widgets.git',
                parsed: { provider: 'github' as const, owner: 'acme', repoName: 'widgets', host: 'github.com' },
              },
            ],
          },
        ]),
      } as unknown as ProjectsRouteOptions['repoDiscovery'],
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/projects/10/servers/local/discover-repositories' });

    expect(res.statusCode).toBe(200);
    expect(res.json().repositories[0].remotes[0].url).toBe('git@github.com:acme/widgets.git');
  });

  it('keeps an ssh:// remote URL (including its git user) unchanged', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'ssh://git@example.com:2222/acme/widgets.git',
                parsed: { provider: 'other' as const, owner: 'acme', repoName: 'widgets', host: 'example.com' },
              },
            ],
          },
        ]),
      } as unknown as ProjectsRouteOptions['repoDiscovery'],
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/projects/10/servers/local/discover-repositories' });

    expect(res.statusCode).toBe(200);
    expect(res.json().repositories[0].remotes[0].url).toBe('ssh://git@example.com:2222/acme/widgets.git');
  });

  it('keeps a local filesystem path remote unchanged (no placeholder string)', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: '/srv/repos/widgets.git',
                parsed: { provider: 'other' as const, owner: null, repoName: null, host: null },
              },
            ],
          },
        ]),
      } as unknown as ProjectsRouteOptions['repoDiscovery'],
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/projects/10/servers/local/discover-repositories' });

    expect(res.statusCode).toBe(200);
    expect(res.json().repositories[0].remotes[0].url).toBe('/srv/repos/widgets.git');
  });

  it('returns an error (not an empty success) when the scan fails', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => { throw new Error('ssh transport unavailable'); }),
      } as unknown as ProjectsRouteOptions['repoDiscovery'],
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/projects/10/servers/local/discover-repositories' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).not.toHaveProperty('repositories');
    expect(res.json().error).toBeTruthy();
  });
});

describe('POST /api/projects/:id/repositories/bulk', () => {
  it('rejects a batch containing a credentialed URL', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: { repositories: [{ url: 'https://user:dummy-token@github.com/acme/widgets.git', provider: 'github' }] },
    });

    expect(res.statusCode).toBe(400);
    expect(opts.projectRepo.addRepository).not.toHaveBeenCalled();
  });

  it('accepts a batch of plain URLs', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: { repositories: [{ url: 'https://github.com/acme/widgets.git', provider: 'github' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(1);
    expect(opts.projectRepo.addRepository).toHaveBeenCalled();
  });
});
