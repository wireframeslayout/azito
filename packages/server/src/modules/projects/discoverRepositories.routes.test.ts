import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';
import { TaskOriginationService } from '../tasks/origination/TaskOriginationService';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { KeyedMutex } from '../../shared/keyedMutex';
import { LocalCloneTargetNotEmptyError } from '../git/LocalRepoCloneService';

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
      updateRepositoryToken: vi.fn(),
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
    localRepoCloneService: { clone: vi.fn() } as unknown as ProjectsRouteOptions['localRepoCloneService'],
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

  it('strips a credential carried only in the query string of a discovered remote URL', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'https://github.com/acme/widgets.git?token=dummy-token',
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
    const url: string = res.json().repositories[0].remotes[0].url;
    expect(url).not.toContain('dummy-token');
    expect(url).toBe('https://github.com/acme/widgets.git');
  });

  it('strips a credential carried only in the fragment of a discovered remote URL', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'https://github.com/acme/widgets.git#access_token=dummy-token',
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
    const url: string = res.json().repositories[0].remotes[0].url;
    expect(url).not.toContain('dummy-token');
    expect(url).toBe('https://github.com/acme/widgets.git');
  });

  it('strips password but keeps the username from an ssh:// remote with a password', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'ssh://user:dummy-secret@example.com:22/acme/widgets.git',
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
    const url: string = res.json().repositories[0].remotes[0].url;
    expect(url).not.toContain('dummy-secret');
    expect(url).toBe('ssh://user@example.com:22/acme/widgets.git');
  });

  it('strips password but keeps the username from a password-carrying scp-like remote', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'user:dummy-secret@example.com:acme/widgets.git',
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
    const url: string = res.json().repositories[0].remotes[0].url;
    expect(url).not.toContain('dummy-secret');
    expect(url).toBe('user@example.com:acme/widgets.git');
  });

  it('drops an unparseable remote instead of returning a placeholder string (Nit finding 2)', async () => {
    const opts = makeOpts({
      repoDiscovery: {
        discover: vi.fn(async () => [
          {
            relativePath: 'widgets',
            absolutePath: '/work/widgets',
            remotes: [
              {
                name: 'origin',
                url: 'https://[bad',
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
    const body = res.json();
    expect(body.repositories[0].remotes).toEqual([]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('unparseable remote url redacted');
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

  it('strips a credential carried only in the query string before storing it', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: { repositories: [{ url: 'https://github.com/acme/widgets.git?token=dummy-token', provider: 'github' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(1);
    const storedUrl = (opts.projectRepo.addRepository as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(storedUrl).not.toContain('dummy-token');
    expect(storedUrl).toBe('https://github.com/acme/widgets.git');
  });

  it('strips a credential carried only in the fragment before storing it', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: { repositories: [{ url: 'https://github.com/acme/widgets.git#access_token=dummy-token', provider: 'github' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(1);
    const storedUrl = (opts.projectRepo.addRepository as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(storedUrl).not.toContain('dummy-token');
    expect(storedUrl).toBe('https://github.com/acme/widgets.git');
  });

  it('rejects an unparseable scheme:// URL instead of storing a placeholder as "added" (Nit finding 2)', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: { repositories: [{ url: 'https://[bad', provider: 'other' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(0);
    expect(res.json().skipped).toBe(1);
    expect(opts.projectRepo.addRepository).not.toHaveBeenCalled();
  });

  it('strips the password but keeps the username when storing a scp-like remote with a password', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: { repositories: [{ url: 'user:dummy-secret@example.com:acme/widgets.git', provider: 'other' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(1);
    const storedUrl = (opts.projectRepo.addRepository as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(storedUrl).not.toContain('dummy-secret');
    expect(storedUrl).toBe('user@example.com:acme/widgets.git');
  });

  it('returns 400 (not 500) for a request sent with no body (Issue #19 review round 2, Minor finding 5)', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/projects/10/repositories/bulk' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
    expect(opts.projectRepo.addRepository).not.toHaveBeenCalled();
  });

  it('returns 400 (not 500) for a non-object JSON body (e.g. a bare array)', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: [1, 2, 3],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
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

  it('returns the created repository ids, in order, for use by a later cleanup call (Issue #87 review, Important finding 1)', async () => {
    const opts = makeOpts();
    let nextId = 100;
    opts.projectRepo.addRepository = vi.fn(() => nextId++);
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories/bulk',
      payload: {
        repositories: [
          { url: 'https://github.com/acme/widgets.git', provider: 'github' },
          { url: 'https://github.com/acme/gadgets.git', provider: 'github' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().added).toBe(2);
    expect(res.json().ids).toEqual([100, 101]);
  });
});

describe('POST /api/projects/:id/repositories (reuse-aware)', () => {
  it('reuses an existing repository row for the same URL instead of creating a duplicate', async () => {
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [{ id: 42, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: true }],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 999),
        findRepositoryById: vi.fn(() => null),
        updateRepositoryToken: vi.fn(),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    // Same repository, different (but equivalent) URL form — ssh vs https,
    // both github.com (a known cross-protocol host) — must still match.
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'git@github.com:acme/widgets.git', provider: 'github' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: 42, reused: true });
    expect(opts.projectRepo.addRepository).not.toHaveBeenCalled();
  });

  it('creates a new row when no existing repository matches the URL', async () => {
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [{ id: 42, name: null, url: 'https://github.com/acme/other-repo.git', provider: 'github' as const, owner: 'acme', repoName: 'other-repo', hasToken: true }],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 999),
        findRepositoryById: vi.fn(() => null),
        updateRepositoryToken: vi.fn(),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github', token: 'dummy-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: 999, reused: false });
    expect(opts.projectRepo.addRepository).toHaveBeenCalledWith(
      10, 'https://github.com/acme/widgets.git', undefined, 'github', undefined, undefined, 'dummy-token',
    );
  });

  // Issue #87 review, Important finding 1a: when several existing rows
  // match the same remote (a pre-existing duplicate), the credentialed row
  // must win over a token-less one, regardless of array order.
  it('prefers a credentialed matching row over a token-less one when both exist', async () => {
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [
            { id: 41, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: false },
            { id: 42, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: true },
          ],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 999),
        findRepositoryById: vi.fn(() => null),
        updateRepositoryToken: vi.fn(),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: 42, reused: true });
    expect(opts.projectRepo.addRepository).not.toHaveBeenCalled();
    // The picked row already has a token — nothing to persist.
    expect(opts.projectRepo.updateRepositoryToken).not.toHaveBeenCalled();
  });

  // Issue #87 review, Important finding 1b: reusing a token-less matching
  // row while a token is supplied must persist that token onto the row,
  // not just return the still-credential-less row as-is.
  it('persists a supplied token onto a reused row that had none', async () => {
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [{ id: 42, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: false }],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 999),
        findRepositoryById: vi.fn(() => null),
        updateRepositoryToken: vi.fn(),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github', token: 'new-dummy-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: 42, reused: true });
    expect(opts.projectRepo.addRepository).not.toHaveBeenCalled();
    expect(opts.projectRepo.updateRepositoryToken).toHaveBeenCalledWith(42, 'new-dummy-token');
  });

  // Issue #87 review, Important finding (token correction): a matching row
  // that already carries a token must still have a newly-supplied,
  // non-empty token persisted onto it — otherwise an operator who corrects
  // a wrong token and re-runs the wizard has the correction silently
  // dropped because `existing.hasToken` was already true.
  it('persists a corrected token onto a reused row even when it already has a token', async () => {
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [{ id: 42, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: true }],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 999),
        findRepositoryById: vi.fn(() => null),
        updateRepositoryToken: vi.fn(),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github', token: 'corrected-dummy-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: 42, reused: true });
    expect(opts.projectRepo.addRepository).not.toHaveBeenCalled();
    expect(opts.projectRepo.updateRepositoryToken).toHaveBeenCalledWith(42, 'corrected-dummy-token');
  });

  // Same scenario driven end-to-end across two consecutive requests against
  // the same reused row: the second, different token must overwrite the
  // first, and a follow-up request with no token must leave it untouched.
  it('persists the second token when the same row is reused twice with different tokens, and leaves it alone when a later call omits one', async () => {
    let currentToken: string | undefined = undefined;
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [{ id: 42, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: currentToken !== undefined }],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 999),
        findRepositoryById: vi.fn(() => null),
        updateRepositoryToken: vi.fn((_id: number, token: string) => { currentToken = token; }),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    // 1st call: token-less row, wrong token supplied — gets persisted.
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github', token: 'wrong-dummy-token' },
    });
    expect(res1.statusCode).toBe(200);
    expect(currentToken).toBe('wrong-dummy-token');

    // 2nd call: row now has a (wrong) token, operator supplies the
    // corrected one — must overwrite, not be skipped due to hasToken.
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github', token: 'corrected-dummy-token' },
    });
    expect(res2.statusCode).toBe(200);
    expect(currentToken).toBe('corrected-dummy-token');
    expect(opts.projectRepo.updateRepositoryToken).toHaveBeenNthCalledWith(2, 42, 'corrected-dummy-token');

    // 3rd call: no token supplied — the existing (corrected) token must
    // not be cleared or otherwise touched.
    const callCountBefore = (opts.projectRepo.updateRepositoryToken as ReturnType<typeof vi.fn>).mock.calls.length;
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github' },
    });
    expect(res3.statusCode).toBe(200);
    expect(currentToken).toBe('corrected-dummy-token');
    expect((opts.projectRepo.updateRepositoryToken as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBefore);
  });

  it('does not attempt to persist a token when reusing a token-less row and none was supplied', async () => {
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [{ id: 42, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: false }],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 999),
        findRepositoryById: vi.fn(() => null),
        updateRepositoryToken: vi.fn(),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/repositories',
      payload: { url: 'https://github.com/acme/widgets.git', provider: 'github' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: 42, reused: true });
    expect(opts.projectRepo.updateRepositoryToken).not.toHaveBeenCalled();
  });
});

describe('POST clone-local', () => {
  function makeCloneOpts(overrides: Partial<ProjectsRouteOptions> = {}) {
    return makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({
          id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main',
          sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], windows: [],
          createdAt: '', updatedAt: '',
          repositories: [{ id: 5, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', hasToken: true }],
        })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 1),
        findRepositoryById: vi.fn((id: number) => id === 5 ? {
          id: 5, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github' as const, owner: 'acme', repoName: 'widgets', token: 'dummy-token',
        } : null),
        updateRepositoryToken: vi.fn(),
        removeRepository: vi.fn(),
      },
      ...overrides,
    });
  }

  it('rejects a non-local server', async () => {
    const opts = makeCloneOpts({
      serverRepo: {
        findAll: vi.fn(() => []),
        findByName: vi.fn(() => ({
          name: 'remote1', type: 'agent' as const, host: 'x', agentPort: null, agentToken: null, agentVersion: null,
          sshHost: 'x', muxRuntime: 'system' as const, sshHostFingerprint: null,
          isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '',
        })),
        create: vi.fn(), update: vi.fn(), updateAgentVersion: vi.fn(), updateFingerprint: vi.fn(),
        clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(), delete: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: '/api/projects/10/servers/remote1/clone-local',
      payload: { repository_id: 5, target_directory: '/work/widgets' },
    });

    expect(res.statusCode).toBe(400);
    expect(opts.localRepoCloneService.clone).not.toHaveBeenCalled();
  });

  it('rejects a repository_id that does not belong to the project', async () => {
    const opts = makeCloneOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: '/api/projects/10/servers/local/clone-local',
      payload: { repository_id: 999, target_directory: '/work/widgets' },
    });

    expect(res.statusCode).toBe(400);
    expect(opts.localRepoCloneService.clone).not.toHaveBeenCalled();
  });

  it('clones the resolved identity with the repository token into the target directory on success', async () => {
    const cloneMock = vi.fn();
    const opts = makeCloneOpts({ localRepoCloneService: { clone: cloneMock } as unknown as ProjectsRouteOptions['localRepoCloneService'] });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: '/api/projects/10/servers/local/clone-local',
      payload: { repository_id: 5, target_directory: '/work/widgets', branch: 'develop' },
    });

    expect(res.statusCode).toBe(200);
    expect(cloneMock).toHaveBeenCalledTimes(1);
    const [identity, token, branch, targetDir] = cloneMock.mock.calls[0];
    expect(identity).toMatchObject({ provider: 'github', owner: 'acme', repo: 'widgets' });
    expect(token).toBe('dummy-token');
    expect(branch).toBe('develop');
    expect(targetDir).toBe('/work/widgets');
  });

  it('returns 409 when the target directory is not empty', async () => {
    const cloneMock = vi.fn(() => { throw new LocalCloneTargetNotEmptyError('/work/widgets'); });
    const opts = makeCloneOpts({ localRepoCloneService: { clone: cloneMock } as unknown as ProjectsRouteOptions['localRepoCloneService'] });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: '/api/projects/10/servers/local/clone-local',
      payload: { repository_id: 5, target_directory: '/work/widgets' },
    });

    expect(res.statusCode).toBe(409);
  });

  it('rejects a relative target_directory (Issue #87 review, Important finding 2)', async () => {
    const cloneMock = vi.fn();
    const opts = makeCloneOpts({ localRepoCloneService: { clone: cloneMock } as unknown as ProjectsRouteOptions['localRepoCloneService'] });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: '/api/projects/10/servers/local/clone-local',
      payload: { repository_id: 5, target_directory: 'widgets' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/absolute/);
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('returns 502 with the (already-redacted) error message on a general clone failure', async () => {
    const cloneMock = vi.fn(() => { throw new Error('git clone failed: fatal: could not resolve host'); });
    const opts = makeCloneOpts({ localRepoCloneService: { clone: cloneMock } as unknown as ProjectsRouteOptions['localRepoCloneService'] });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url: '/api/projects/10/servers/local/clone-local',
      payload: { repository_id: 5, target_directory: '/work/widgets' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('could not resolve host');
  });
});
