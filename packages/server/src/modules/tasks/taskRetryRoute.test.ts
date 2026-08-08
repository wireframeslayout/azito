import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task } from './Task';

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
    tmuxWindow: 'task-1',
    selfReviewMaxAttempts: null,
    requirePlanApproval: false,
    source: 'local',
    sourceRef: null,
    worktreePath: '/work/.worktrees/task-1',
    worktreeBranch: 'feat/test',
    baseBranch: 'main',
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: 'feat/test',
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
    createdByKind: 'operator',
    createdById: null,
    createdViaGeneration: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// Reuses the same fixture shape as taskArchiveRestore.test.ts's makeOpts —
// this file only tweaks the pieces POST /api/tasks/:id/retry actually
// touches (killWindow's outcome, revokeTaskWindowGeneration).
function makeOpts(taskOverrides?: Partial<Task>, killWindowImpl?: () => Promise<{ stdout: string; stderr: string; code: number }>): TasksRouteOptions {
  const task = makeTask(taskOverrides);
  return {
    taskRepo: {
      findAll: vi.fn(() => [task]),
      findByProject: vi.fn(() => [task]),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn((id: number) => (id === task.id ? task : null)),
      create: vi.fn(() => 1),
      update: vi.fn((id: number, data: Partial<Task>) => { Object.assign(task, data); }),
      updateStatus: vi.fn(),
      updateCurrentPhase: vi.fn(),
      touch: vi.fn(),
      delete: vi.fn(),
      consumePendingApproval: vi.fn(() => false),
      recordExecutionGateBlock: vi.fn(() => true),
      preApproveExecution: vi.fn(() => true),
      countChildren: vi.fn(() => 0),
      countChildrenInGeneration: vi.fn(() => 0),
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
      killWindow: vi.fn(killWindowImpl ?? (async () => ({ stdout: '', stderr: '', code: 0 }))),
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
    worktreeServiceFactory: {
      create: vi.fn(() => ({
        create: vi.fn(async () => ({ path: '/work/.worktrees/task-1', branch: 'feat/test' })),
        remove: vi.fn(async () => {}),
      })),
    } as unknown as TasksRouteOptions['worktreeServiceFactory'],
    transportFactory: {
      getTransport: vi.fn(() => ({})),
    } as unknown as TasksRouteOptions['transportFactory'],
    windowRepo: {
      findByTaskIds: vi.fn(() => new Map()),
      add: vi.fn(() => 100),
      findAll: vi.fn(() => []),
      findById: vi.fn(() => undefined),
      findByProject: vi.fn(() => []),
      findByTask: vi.fn(() => [{ id: 50, ownerType: 'task' as const, taskId: 1, isPrimary: true, serverName: 'test-server', tmuxTarget: 'azito:task-1.1', label: 'task-1', windowType: 'agent' as const, workerType: 'claude', workerModel: null, agentSessionId: null, launchCommand: null, workingDirectory: null, paneLayout: null, projectId: null, createdAt: '' }]),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findByServerAndTarget: vi.fn(() => undefined),
      findByServerAndSession: vi.fn(() => []),
      update: vi.fn(),
      updateAgentSessionIdByWindow: vi.fn(),
      remove: vi.fn(),
      removeByServerAndTarget: vi.fn(() => 0),
      updatePaneLayout: vi.fn(),
    },
    respawnService: {
      respawn: vi.fn(async () => ({ tmuxTarget: 'azito:task-1.1' })),
    } as unknown as TasksRouteOptions['respawnService'],
    taskRestoreService: {
      restore: vi.fn(async () => ({ tmuxTarget: 'azito:task-1.1', worktreePath: '/work/.worktrees/task-1' })),
    } as unknown as TasksRouteOptions['taskRestoreService'],
    unitTypeLoader: { getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })) } as unknown as TasksRouteOptions['unitTypeLoader'],
    sidekickLoader: { get: vi.fn(() => undefined) } as unknown as TasksRouteOptions['sidekickLoader'],
    projectSecretRepo: { findByProject: vi.fn(() => []) } as unknown as TasksRouteOptions['projectSecretRepo'],
    auditLogService: { record: vi.fn() } as unknown as TasksRouteOptions['auditLogService'],
    originationService: { create: vi.fn(() => 1) } as unknown as TasksRouteOptions['originationService'],
    taskTokenRepo: { issue: vi.fn(), verify: vi.fn(() => false), revokeAllForTask: vi.fn(() => 0), issueNextGeneration: vi.fn(), getActiveGeneration: vi.fn(() => null) } as unknown as TasksRouteOptions['taskTokenRepo'],
    revokeTaskWindowGeneration: vi.fn(),
  };
}

// Issue #28 review Important finding: retry used to clear `tmuxWindow`
// without killing the abandoned window or revoking its task-token
// generation — an abandoned pane kept running with a still-valid token, and
// losing `tmuxWindow` meant the next execution's kill-and-rotate had nothing
// left to find. These tests confirm the fixed order: kill first, revoke only
// once the kill is confirmed, then clear tmuxWindow.
//
// Phase B follow-up (third-party review, still Important): a kill failure —
// or an unresolvable server — used to still reset the task and clear
// `tmuxWindow` anyway (fail-open). It must now fail-closed: the task is left
// untouched and the request errors, so the abandoned pane and its token stay
// tracked until a human confirms it is actually dead.
describe('POST /api/tasks/:id/retry', () => {
  it('kills the abandoned tmux window and revokes its token generation before clearing tmuxWindow', async () => {
    const opts = makeOpts({ status: 'failed', tmuxWindow: 'task-1' });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/retry' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(opts.tmux.killWindow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-server' }),
      'azito:task-1',
    );
    expect(opts.revokeTaskWindowGeneration).toHaveBeenCalledWith(1, 'retry_abandoned_window');
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { status: 'open', tmuxWindow: null });
  });

  it('fails closed and leaves tmuxWindow/status untouched when the kill fails (still-live pane)', async () => {
    const opts = makeOpts(
      { status: 'failed', tmuxWindow: 'task-1' },
      async () => ({ stdout: '', stderr: 'some other tmux error', code: 1 }),
    );
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/retry' });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toMatch(/Failed to kill/);
    expect(opts.tmux.killWindow).toHaveBeenCalled();
    expect(opts.revokeTaskWindowGeneration).not.toHaveBeenCalled();
    // Fail-closed: the task must NOT be reset — the abandoned pane may still
    // be running with a still-valid token, so `tmuxWindow` and `status` stay
    // exactly as they were for the next attempt to find.
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });

  it('fails closed when the abandoned window\'s server cannot be resolved', async () => {
    const opts = makeOpts({ status: 'failed', tmuxWindow: 'task-1' });
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/retry' });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.payload).error).toMatch(/Could not resolve the server/);
    expect(opts.tmux.killWindow).not.toHaveBeenCalled();
    expect(opts.revokeTaskWindowGeneration).not.toHaveBeenCalled();
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });

  it('skips the kill/revoke step entirely when the task has no tmuxWindow', async () => {
    const opts = makeOpts({ status: 'failed', tmuxWindow: null });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/retry' });

    expect(res.statusCode).toBe(200);
    expect(opts.tmux.killWindow).not.toHaveBeenCalled();
    expect(opts.revokeTaskWindowGeneration).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-retryable status', async () => {
    const opts = makeOpts({ status: 'open' });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/retry' });

    expect(res.statusCode).toBe(400);
    expect(opts.tmux.killWindow).not.toHaveBeenCalled();
  });

  it('returns 404 when the task does not exist', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/999/retry' });

    expect(res.statusCode).toBe(404);
  });
});
