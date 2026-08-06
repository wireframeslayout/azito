import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task } from './Task';
import { ExecutionGateDeniedError } from './execution/ExecutionGate';

// Covers Issue #328's client-facing surface on the tasks routes: input_trust
// must never be settable from a request body (only server-side code paths —
// e.g. import-issue — may set it), and an untrusted task may not have its
// own plan-approval requirement turned off via PUT.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Test task',
    description: null,
    status: 'open',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: true,
    source: 'local',
    sourceRef: null,
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: null,
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: null,
    planMarkdown: null,
    pendingQuestions: null,
    changedFiles: null,
    summaryJson: null,
    prUrl: null,
    agentSessionId: null,
    inputTrust: 'trusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: null,
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(existingTask: Task): { opts: TasksRouteOptions; createCalls: Record<string, unknown>[] } {
  const createCalls: Record<string, unknown>[] = [];
  const opts: TasksRouteOptions = {
    taskRepo: {
      findAll: vi.fn(() => []),
      findByProject: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn((id: number) => (id === existingTask.id ? existingTask : null)),
      create: vi.fn((data: Record<string, unknown>) => { createCalls.push(data); return 2; }),
      update: vi.fn(),
      updateStatus: vi.fn(),
      updateCurrentPhase: vi.fn(),
      touch: vi.fn(),
      delete: vi.fn(),
      consumePendingApproval: vi.fn(() => false),
    },
    projectRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, servers: [], repositories: [], windows: [], createdAt: '', updatedAt: '' })),
      create: vi.fn(() => 10),
      update: vi.fn(),
      delete: vi.fn(),
      addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => null),
      removeRepository: vi.fn(),
    },
    projectServerRepo: {
      findByProject: vi.fn(() => [{ projectId: 10, serverName: 'test-server', workingDirectory: '/work', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const }]),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: '/work', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const })),
      upsert: vi.fn(),
      remove: vi.fn(),
    },
    logRepo: {
      findByTask: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      append: vi.fn(),
    },
    executeTaskUseCase: {
      stopByTaskId: vi.fn(() => false),
      execute: vi.fn(),
      followUp: vi.fn(),
      events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    } as unknown as TasksRouteOptions['executeTaskUseCase'],
    unitRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => null),
      create: vi.fn(() => 20),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tmux: {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'w' })),
      createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      sendKeys: vi.fn(async () => {}),
      checkPaneExists: vi.fn(async () => true),
      killPane: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    } as unknown as TasksRouteOptions['tmux'],
    serverRepo: {
      findAll: vi.fn(() => []),
      findByName: vi.fn(() => ({ name: 'test-server', type: 'local' as const, host: '', agentPort: null, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, createdAt: '' })),
      create: vi.fn(),
      update: vi.fn(),
      updateAgentVersion: vi.fn(),
      updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(),
      delete: vi.fn(),
    },
    worktreeServiceFactory: { create: vi.fn() } as unknown as TasksRouteOptions['worktreeServiceFactory'],
    transportFactory: { getTransport: vi.fn(() => ({})) } as unknown as TasksRouteOptions['transportFactory'],
    windowRepo: {
      findByTaskIds: vi.fn(() => new Map()),
      add: vi.fn(() => 100),
      findAll: vi.fn(() => []),
      findById: vi.fn(() => undefined),
      findByProject: vi.fn(() => []),
      findByTask: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findByServerAndTarget: vi.fn(() => undefined),
      update: vi.fn(),
      updateAgentSessionIdByWindow: vi.fn(),
      remove: vi.fn(),
      removeByServerAndTarget: vi.fn(() => 0),
      updatePaneLayout: vi.fn(),
    },
    respawnService: {
      respawn: vi.fn(async () => ({ tmuxTarget: 'azito:task-1.1' })),
      resumeLegacySession: vi.fn(async () => ({ windowName: 'task-1' })),
    } as unknown as TasksRouteOptions['respawnService'],
    taskRestoreService: { restore: vi.fn(async () => ({ tmuxTarget: 'azito:task-1.1', worktreePath: null })) } as unknown as TasksRouteOptions['taskRestoreService'],
    unitTypeLoader: { getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })) } as unknown as TasksRouteOptions['unitTypeLoader'],
  };
  return { opts, createCalls };
}

describe('POST /api/tasks — input_trust immutability (Issue #328)', () => {
  it('ignores an input_trust field in the request body and always creates a trusted task', async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'New task', input_trust: 'untrusted' },
    });

    expect(res.statusCode).toBe(200);
    expect(createCalls[0]).toMatchObject({ inputTrust: 'trusted', executionApprovedFingerprintHash: null });
  });
});

describe('PUT /api/tasks/:id — require_plan_approval guard for untrusted tasks (Issue #328)', () => {
  it('rejects disabling require_plan_approval on an untrusted task', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'untrusted', requirePlanApproval: true }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { require_plan_approval: false },
    });

    expect(res.statusCode).toBe(400);
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });

  it('allows enabling require_plan_approval on an untrusted task', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'untrusted', requirePlanApproval: false }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { require_plan_approval: true },
    });

    expect(res.statusCode).toBe(200);
  });

  it('allows disabling require_plan_approval on a trusted task (unaffected — legacy behavior preserved)', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'trusted', requirePlanApproval: true }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { require_plan_approval: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it('does not accept input_trust from the PUT body (no such field is ever read into the update call)', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'trusted' }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { input_trust: 'untrusted' },
    });

    const updateCall = (opts.taskRepo.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1]).not.toHaveProperty('inputTrust');
  });
});

describe('POST /api/tasks/:id/recover-session — execution gate (Issue #328)', () => {
  it('translates WindowRespawnService gate errors into the same HTTP shape as /execute (window-record path)', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'untrusted', status: 'pending_approval' }));
    opts.windowRepo.findByTask = vi.fn(() => [
      { id: 1, ownerType: 'task' as const, projectId: null, taskId: 1, serverName: 'test-server', tmuxTarget: 'azito:task-1.1', label: 'task-1', isPrimary: true, windowType: 'agent' as const, workerType: 'claude', workerModel: 'opus', agentSessionId: null, launchCommand: null, workingDirectory: null, paneLayout: null, createdAt: '' },
    ]);
    opts.respawnService = {
      respawn: vi.fn(async () => { throw new ExecutionGateDeniedError(1); }),
    } as unknown as TasksRouteOptions['respawnService'];
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/recover-session' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'execution_denied' });
  });

  it('gates the legacy pre-migration-034 fallback path (no window record) before creating a tmux window', async () => {
    // The gate check itself now lives in WindowRespawnService.resumeLegacySession
    // (see its own tests) — this route only needs to translate that error
    // into the same HTTP shape as every other execution-gate call site.
    const { opts } = makeOpts(makeTask({
      inputTrust: 'untrusted', status: 'open', agentSessionId: '11111111-1111-1111-1111-111111111111',
    }));
    opts.windowRepo.findByTask = vi.fn(() => []);
    opts.respawnService = {
      resumeLegacySession: vi.fn(async () => { throw new ExecutionGateDeniedError(1); }),
    } as unknown as TasksRouteOptions['respawnService'];
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/recover-session' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'execution_denied' });
    expect(opts.tmux.createWindow).not.toHaveBeenCalled();
  });

  it('allows the legacy fallback path for a trusted task', async () => {
    const { opts } = makeOpts(makeTask({
      inputTrust: 'trusted', status: 'open', agentSessionId: '11111111-1111-1111-1111-111111111111',
    }));
    opts.windowRepo.findByTask = vi.fn(() => []);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/recover-session' });

    expect(res.statusCode).toBe(200);
    expect(opts.respawnService.resumeLegacySession).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'test-server' }));
  });
});
