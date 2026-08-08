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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(taskOverrides?: Partial<Task>): TasksRouteOptions {
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
    taskTokenRepo: { issue: vi.fn(), verify: vi.fn(() => false), revokeAllForTask: vi.fn(() => 0) } as unknown as TasksRouteOptions['taskTokenRepo'],
    auditLogService: { record: vi.fn() } as unknown as TasksRouteOptions['auditLogService'],
  };
}

describe('POST /api/tasks/:id/archive', () => {
  it('archives a task: stops execution, cleans up, removes windows, sets status to archived', async () => {
    const opts = makeOpts({ status: 'open' });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/archive' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(opts.executeTaskUseCase.stopByTaskId).toHaveBeenCalledWith(1);
    expect(opts.windowRepo.remove).toHaveBeenCalledWith(50);
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { status: 'archived', tmuxWindow: null });
  });

  it('returns ok when task is already archived (idempotent)', async () => {
    const opts = makeOpts({ status: 'archived' });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/archive' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(opts.executeTaskUseCase.stopByTaskId).not.toHaveBeenCalled();
  });

  it('returns 404 when task does not exist', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/999/archive' });

    expect(res.statusCode).toBe(404);
  });

  // Issue #328: archiving a `pending_approval` task used to overwrite
  // `status` to 'archived' while leaving `pendingOperation` set — the same
  // "changes status without consuming the pending approval" bug PUT
  // /api/tasks/:id's pending_approval guard already closed for arbitrary
  // status edits. That left the task un-approvable (GET
  // .../execution-approval 404s once status isn't 'pending_approval') AND
  // un-restorable (checkExecutionGate still blocks on the leftover
  // pendingOperation) — permanently stuck. The fix consumes the pending
  // approval as a denial (landing on 'archived', not denial's usual
  // 'failed') atomically before archiving, via the SAME denyPendingApproval()
  // path POST /api/tasks/:id/approve-execution's denial branch uses.
  it('consumes a pending approval as a denial before archiving a task stuck in pending_approval (Issue #328)', async () => {
    const opts = makeOpts({
      status: 'pending_approval',
      pendingOperation: 'execute',
      pendingOperationWindowId: null,
      pendingOperationPriorStatus: 'open',
    });
    // Stateful consumePendingApproval mock (mirrors executionApprovalRoute.
    // test.ts's makeStatefulOpts pattern) — the base fixture's `vi.fn(() =>
    // false)` would make this test indistinguishable from "the approval was
    // never consumed", which is exactly the bug this test guards against.
    const task = opts.taskRepo.findById(1) as Task;
    opts.taskRepo.consumePendingApproval = vi.fn((id: number, fields: { status?: Task['status']; executionApprovedFingerprintHash?: string }) => {
      if (id !== 1 || task.status !== 'pending_approval' || task.pendingOperation === null) return false;
      Object.assign(task, {
        ...(fields.status !== undefined ? { status: fields.status } : {}),
        ...(fields.executionApprovedFingerprintHash !== undefined ? { executionApprovedFingerprintHash: fields.executionApprovedFingerprintHash } : {}),
        pendingOperation: null,
        pendingOperationWindowId: null,
        pendingOperationPriorStatus: null,
      });
      return true;
    });

    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/archive' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
    expect(opts.taskRepo.consumePendingApproval).toHaveBeenCalledWith(1, { status: 'archived' });
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'status_change', { status: 'archived', reason: 'execution_denied' });
    // Not left stuck: pendingOperation is cleared and status actually landed
    // on 'archived' — neither the un-approvable nor un-restorable dead end
    // the pre-fix code left behind.
    expect(task.pendingOperation).toBeNull();
    expect(task.status).toBe('archived');
  });

  it('returns 409 without archiving when the pending approval was already resolved by a concurrent request', async () => {
    const opts = makeOpts({
      status: 'pending_approval',
      pendingOperation: 'execute',
      pendingOperationWindowId: null,
      pendingOperationPriorStatus: 'open',
    });
    opts.taskRepo.consumePendingApproval = vi.fn(() => false);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/archive' });

    expect(res.statusCode).toBe(409);
    expect(opts.executeTaskUseCase.stopByTaskId).not.toHaveBeenCalled();
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks/:id/restore', () => {
  it('restores an archived task via taskRestoreService', async () => {
    const opts = makeOpts({ status: 'archived' });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/restore' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true, tmuxTarget: 'azito:task-1.1', worktreePath: '/work/.worktrees/task-1' });
    expect(opts.taskRestoreService.restore).toHaveBeenCalled();
  });

  it('returns 400 when task is not archived', async () => {
    const opts = makeOpts({ status: 'open' });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/restore' });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload)).toEqual({ error: "Task status 'open' is not restorable" });
  });

  it('returns 500 when restore fails', async () => {
    const opts = makeOpts({ status: 'archived' });
    (opts.taskRestoreService.restore as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Server unreachable'));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/restore' });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.payload)).toEqual({ error: 'Server unreachable' });
  });

  it('returns 404 when task does not exist', async () => {
    const opts = makeOpts();
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/999/restore' });

    expect(res.statusCode).toBe(404);
  });
});
