import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import projectsRoutes from './routes';
import type { ProjectsRouteOptions } from './routes';
import { TaskOriginationService } from '../tasks/origination/TaskOriginationService';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { KeyedMutex } from '../../shared/keyedMutex';

// Covers Issue #328's project-server-policy surface: 'allow' must be
// rejected at the API boundary (no isolated execution profile exists yet to
// make it safe), and import-issue must mark the created task untrusted
// regardless of what `source`/`unit_id` etc. are passed.

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
  // A real TaskOriginationService wrapping the mock taskRepo above — so
  // import-issue's "task ends up untrusted" assertions below still exercise
  // the actual deriveInputTrust() mapping (via taskRepo.create's recorded
  // call args) rather than a hand-maintained duplicate of that logic here.
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
    ...overrides,
  };
}

describe('PUT /api/projects/:id/servers/:serverName — input_policy (Issue #328 / Issue #29 Step 3a)', () => {
  it('rejects input_policy "allow" when the target server has no isolation intent declared', async () => {
    const opts = makeOpts(); // default serverRepo.findByName returns null (no server row at all)
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { input_policy: 'allow' },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('input_policy_allow_requires_isolation');
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects input_policy "allow" when the server row exists but isolationIntent is false', async () => {
    const opts = makeOpts({
      serverRepo: {
        findAll: vi.fn(() => []),
        findByName: vi.fn(() => ({
          name: 'test-server', type: 'agent' as const, host: null, agentPort: null, agentToken: null, agentVersion: null,
          sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const,
          isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01',
        })),
        create: vi.fn(),
        update: vi.fn(),
        updateAgentVersion: vi.fn(),
        updateFingerprint: vi.fn(),
        clearFingerprint: vi.fn(),
        updateIsolationIntent: vi.fn(),
        delete: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { input_policy: 'allow' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('input_policy_allow_requires_isolation');
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('accepts input_policy "allow" when the server has isolation intent declared — verification is NOT required at configuration time', async () => {
    const opts = makeOpts({
      serverRepo: {
        findAll: vi.fn(() => []),
        findByName: vi.fn(() => ({
          name: 'test-server', type: 'agent' as const, host: null, agentPort: null, agentToken: null, agentVersion: null,
          sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const,
          // isolationIntent declared, but never verified — still accepted at
          // the config boundary; the run-time gate (resolveEffectiveInputPolicy)
          // is what keeps 'allow' degraded until a doctor run verifies it.
          isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01',
        })),
        create: vi.fn(),
        update: vi.fn(),
        updateAgentVersion: vi.fn(),
        updateFingerprint: vi.fn(),
        clearFingerprint: vi.fn(),
        updateIsolationIntent: vi.fn(),
        delete: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { input_policy: 'allow' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ inputPolicy: 'allow' }));
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
          projectId: 10, serverName: 'test-server', workingDirectory: '/srv/repo', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false,
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
          projectId: 10, serverName: 'test-server', workingDirectory: '/srv/repo', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false,
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

  // Issue #29 review (10th pass), Critical finding 1: the project-session
  // bootstrap (createSession into `project.slug`, when the session doesn't
  // exist yet) previously ran with no isolation lock at all, against
  // whatever `srv` this handler happened to resolve at the top — now routed
  // through ensureSessionWithLock, so createSession must see the row
  // re-read INSIDE the lock (serverRepo.findByName, called a second time),
  // not that earlier one. Tags each returned server via `agentVersion` so
  // the assertion can tell the two apart.
  it('creates the project tmux session using the server row re-read inside the isolation lock, not the one resolved before the lock', async () => {
    let generation = 0;
    const opts = makeOpts({
      serverRepo: {
        findAll: vi.fn(() => []),
        findByName: vi.fn(() => {
          generation += 1;
          return {
            name: 'test-server', type: 'local' as const, host: null, agentPort: null, agentToken: null,
            agentVersion: `gen-${generation}`,
            sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const,
            isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01',
          };
        }),
        create: vi.fn(),
        update: vi.fn(),
        updateAgentVersion: vi.fn(),
        updateFingerprint: vi.fn(),
        clearFingerprint: vi.fn(),
        updateIsolationIntent: vi.fn(),
        delete: vi.fn(),
      },
      tmux: {
        listSessions: vi.fn(async () => []),
        createSession: vi.fn(async () => {}),
        uiTokenEnvForServer: vi.fn(() => ({})),
      } as unknown as ProjectsRouteOptions['tmux'],
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { working_directory: '/srv/repo' },
    });

    expect(res.statusCode).toBe(200);
    // The FIRST findByName call (top of the handler, `srv`) produced
    // `gen-1` — createSession must NOT have seen that row.
    expect(opts.tmux.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentVersion: 'gen-1' }),
      'p',
      expect.anything(),
    );
  });
});

describe('PUT /api/projects/:id/servers/:serverName — distribute_code (Issue #87 third-party review, Minor finding)', () => {
  it('rejects a non-boolean distribute_code (e.g. a string "false") with 400 and does not persist it', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { distribute_code: 'false' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('distribute_code must be a boolean');
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean distribute_code (an object) with 400', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { distribute_code: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('distribute_code must be a boolean');
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean distribute_code (the number 1) with 400', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { distribute_code: 1 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('distribute_code must be a boolean');
    expect(opts.projectServerRepo.upsert).not.toHaveBeenCalled();
  });

  it('accepts a real boolean distribute_code and persists it', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { distribute_code: true },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ distributeCode: true }));
  });

  it('preserves the existing distribute_code value when the key is omitted', async () => {
    const opts = makeOpts({
      projectServerRepo: {
        findByProject: vi.fn(() => []),
        findByServer: vi.fn(() => []),
        find: vi.fn(() => ({
          projectId: 10, serverName: 'test-server', workingDirectory: '/srv/repo', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: true,
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
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ distributeCode: true }));
  });

  // Issue #87 review finding (Minor 3, forge/87-mirror follow-up): the
  // frontend form hides the toggle for a `local` target server but its
  // underlying state can still survive a stale/anomalous save (or a direct
  // API caller bypassing the form entirely) and reach this endpoint as
  // `distribute_code: true`. `local` IS the hub itself, so distribution is
  // structurally meaningless there (ExecuteTaskUseCase already excludes it
  // outright) — normalized to `false` rather than rejected with 400, so an
  // otherwise-valid save isn't blocked by a field the caller may not even
  // know is wrong.
  it('normalizes distribute_code to false when the target server type is local, even if the caller sent true', async () => {
    const opts = makeOpts({
      serverRepo: {
        findAll: vi.fn(() => []),
        findByName: vi.fn(() => ({
          name: 'test-server', type: 'local' as const, host: null, agentPort: null, agentToken: null, agentVersion: null,
          sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const,
          isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01',
        })),
        create: vi.fn(),
        update: vi.fn(),
        updateAgentVersion: vi.fn(),
        updateFingerprint: vi.fn(),
        clearFingerprint: vi.fn(),
        updateIsolationIntent: vi.fn(),
        delete: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { distribute_code: true },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ distributeCode: false }));
  });

  it('does not normalize distribute_code for a non-local (agent) target server', async () => {
    const opts = makeOpts({
      serverRepo: {
        findAll: vi.fn(() => []),
        findByName: vi.fn(() => ({
          name: 'test-server', type: 'agent' as const, host: null, agentPort: null, agentToken: null, agentVersion: null,
          sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const,
          isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01',
        })),
        create: vi.fn(),
        update: vi.fn(),
        updateAgentVersion: vi.fn(),
        updateFingerprint: vi.fn(),
        clearFingerprint: vi.fn(),
        updateIsolationIntent: vi.fn(),
        delete: vi.fn(),
      },
    });
    const app = Fastify();
    await app.register(projectsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/10/servers/test-server',
      payload: { distribute_code: true },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.projectServerRepo.upsert).toHaveBeenCalledWith(expect.objectContaining({ distributeCode: true }));
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
