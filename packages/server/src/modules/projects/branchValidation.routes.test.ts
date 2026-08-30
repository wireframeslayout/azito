import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';
import { TaskOriginationService } from '../tasks/origination/TaskOriginationService';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { KeyedMutex } from '../../shared/keyedMutex';

// Issue #87 third-party review, 11th round, Important finding 1: a project's
// `default_branch` and a project_servers row's `branch` feed the same
// resolveBaseBranch()/canonicalizeBaseBranch() chain a task's own
// base_branch/branch/target_branch do (TaskExecutionEnv.ts) — new input to
// EITHER endpoint must reject `refs/...` and `origin/...` the same way
// tasks/routes.ts's validateGitFields already does, so a misconfigured
// project can't reach the same "distribute() tries to fetch
// refs/heads/origin/main" failure a task-level guard already closed.

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
      findById: vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, servers: [], repositories: [], windows: [], createdAt: '', updatedAt: '' })),
      create: vi.fn(() => 10),
      update: vi.fn(),
      delete: vi.fn(),
      addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => ({ id: 1, name: 'widgets', url: 'https://github.com/acme/widgets', provider: 'github' as const, owner: 'acme', repoName: 'widgets', token: null })),
      removeRepository: vi.fn(),
    },
    projectServerRepo: {
      findByProject: vi.fn(() => []),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => null),
      upsert: vi.fn(),
      remove: vi.fn(),
    },
    taskRepo,
    originationService,
    gitProvider: {
      getIssue: vi.fn(async () => ({ number: 5, title: 'Fix the thing', body: 'External issue body', state: 'open', htmlUrl: 'https://github.com/acme/widgets/issues/5' })),
    } as unknown as ProjectsRouteOptions['gitProvider'],
    tmux: {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => {}),
    } as unknown as ProjectsRouteOptions['tmux'],
    serverRepo: {
      findAll: vi.fn(() => []),
      findByName: vi.fn(() => null),
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

describe('PUT /api/projects/:id — default_branch input validation (Issue #87 third-party review, 11th round, Important finding 1)', () => {
  it('rejects a refs/-qualified default_branch', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10',
      payload: { default_branch: 'refs/heads/main' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/default_branch/);
    expect(opts.projectRepo.update).not.toHaveBeenCalled();
  });

  it('rejects an origin/-qualified default_branch', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10',
      payload: { default_branch: 'origin/main' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/default_branch/);
    expect(opts.projectRepo.update).not.toHaveBeenCalled();
  });

  it('accepts a plain default_branch', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10',
      payload: { default_branch: 'develop' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectRepo.update).toHaveBeenCalledWith(10, expect.objectContaining({ defaultBranch: 'develop' }));
  });

  it('does not reject an empty default_branch (clears the field, falls back downstream)', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10',
      payload: { default_branch: '' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-string default_branch (400, not a 500 crash) — Issue #87 14th-round review, Minor finding 3', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10',
      payload: { default_branch: 123 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/default_branch/);
    expect(opts.projectRepo.update).not.toHaveBeenCalled();
  });

  it('does not run this new check against an already-stored value when default_branch is omitted from the request', async () => {
    // Pre-existing data saved before this check existed (e.g. 'origin/main')
    // must keep working — this is an input-boundary check only.
    const opts = makeOpts({
      projectRepo: {
        findAll: vi.fn(() => []),
        findById: vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'origin/main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, servers: [], repositories: [], windows: [], createdAt: '', updatedAt: '' })),
        create: vi.fn(() => 10),
        update: vi.fn(),
        delete: vi.fn(),
        addRepository: vi.fn(() => 1),
        findRepositoryById: vi.fn(() => ({ id: 1, name: 'widgets', url: 'https://github.com/acme/widgets', provider: 'github' as const, owner: 'acme', repoName: 'widgets', token: null })),
        removeRepository: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10',
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectRepo.update).toHaveBeenCalledWith(10, expect.objectContaining({ defaultBranch: 'origin/main' }));
  });
});

describe('PUT /api/projects/:id/servers/:serverName — branch input validation (Issue #87 third-party review, 11th round, Important finding 1)', () => {
  it('rejects a refs/-qualified branch', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { branch: 'refs/heads/main' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/branch/);
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects an origin/-qualified branch', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { branch: 'origin/main' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/branch/);
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('accepts a plain branch', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { branch: 'develop' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ branch: 'develop' }));
  });

  it('does not reject a null branch (clears the field)', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { branch: null },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-string branch (400, not a 500 crash) — Issue #87 14th-round review, Minor finding 3', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { branch: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/branch/);
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });
});
