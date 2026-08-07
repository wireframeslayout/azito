import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';

// Covers Issue #328's project-server-policy surface: 'allow' must be
// rejected at the API boundary (no isolated execution profile exists yet to
// make it safe), and import-issue must mark the created task untrusted
// regardless of what `source`/`unit_id` etc. are passed.

function makeOpts(overrides: Partial<ProjectsRouteOptions> = {}): ProjectsRouteOptions {
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
    taskRepo: {
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
    },
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
      delete: vi.fn(),
    },
    projectSecretRepo: {
      findByProject: vi.fn(() => []),
    } as unknown as ProjectsRouteOptions['projectSecretRepo'],
    ...overrides,
  };
}

describe('PUT /api/projects/:id/servers/:serverName — input_policy (Issue #328)', () => {
  it('rejects input_policy "allow" (isolated execution profile not implemented yet)', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { input_policy: 'allow' },
    });

    expect(res.statusCode).toBe(400);
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('accepts input_policy "deny"', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { input_policy: 'deny' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ inputPolicy: 'deny' }));
  });

  it('defaults to "manual-approval" when input_policy is omitted on a new row', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { working_directory: '/work' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ inputPolicy: 'manual-approval' }));
  });

  it('preserves working_directory and branch when a PUT sends only input_policy', async () => {
    // Regression test: PUT used to overwrite workingDirectory/branch with
    // `body.xxx ?? null` unconditionally, so a policy-only update silently
    // wiped both fields — and workingDirectory is the containment boundary
    // PathContainment.ts enforces, so losing it also lost that boundary.
    const opts = makeOpts({
      projectServerRepo: {
        findByProject: vi.fn(() => []),
        findByServer: vi.fn(() => []),
        find: vi.fn(() => ({
          projectId: 10, serverName: 'test-server', workingDirectory: '/srv/repo', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const,
        })),
        upsert: vi.fn(),
        remove: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { input_policy: 'deny' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/srv/repo',
      branch: 'main',
      inputPolicy: 'deny',
    }));
  });

  it('clears working_directory and branch when explicitly sent as null', async () => {
    const opts = makeOpts({
      projectServerRepo: {
        findByProject: vi.fn(() => []),
        findByServer: vi.fn(() => []),
        find: vi.fn(() => ({
          projectId: 10, serverName: 'test-server', workingDirectory: '/srv/repo', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const,
        })),
        upsert: vi.fn(),
        remove: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { working_directory: null, branch: null },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: null,
      branch: null,
    }));
  });
});

describe('POST /api/projects/:id/import-issue — marks the created task untrusted (Issue #328)', () => {
  it('creates the task with inputTrust: untrusted regardless of provider', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/import-issue',
      payload: { repo_id: 1, issue_number: 5, unit_id: 20 },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      inputTrust: 'untrusted',
      executionApprovedFingerprintHash: null,
      source: 'github',
    }));
  });
});
