import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task } from './Task';
import { ExecutionGatePendingApprovalError } from './execution/ExecutionGate';

// POST /api/tasks/:id/answer — Issue #328 sixth-round review finding 1:
// the route used to clear task.pendingQuestions and fire followUp()
// (`.catch(() => {})`) BEFORE knowing whether the untrusted-input execution
// gate would block it. A block then lost both the question record (needed
// to resubmit) and the human's answer text, while the client had already
// been told `{ ok: true }`. These tests assert the fix: the gate is checked
// synchronously first, and a block leaves pendingQuestions/task.status
// untouched and returns 409 instead.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Test task',
    description: null,
    status: 'waiting_input',
    currentPhase: 'implementing',
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: 'task-1',
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
    pendingQuestions: JSON.stringify([{ text: 'Which approach?', type: 'text' }]),
    changedFiles: null,
    summaryJson: null,
    prUrl: null,
    agentSessionId: null,
    inputTrust: 'untrusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: null,
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(existingTask: Task, opts: { gateAllows: boolean }): { opts: TasksRouteOptions; task: Task } {
  // Stateful findById (same pattern as approveExecution.routes.test.ts):
  // taskRepo.update()/updateStatus() mutate this object in place, so a test
  // can assert the row's state AFTER the route handler runs.
  const task: Task = { ...existingTask };

  const enforceExecutionGate = vi.fn(() => {
    if (!opts.gateAllows) {
      throw new ExecutionGatePendingApprovalError(task.id);
    }
    return { project: null, projectServer: null };
  });

  const routeOpts: TasksRouteOptions = {
    taskRepo: {
      findAll: vi.fn(() => []),
      findByProject: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn((id: number) => (id === task.id ? task : null)),
      create: vi.fn(() => 2),
      update: vi.fn((_id: number, data: Partial<Task>) => Object.assign(task, data)),
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
      followUp: vi.fn(async () => {}),
      enforceExecutionGate,
      events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    } as unknown as TasksRouteOptions['executeTaskUseCase'],
    unitRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 20, name: 'Unit', unitType: 'devops', systemPrompt: null, selfReviewMaxAttempts: 2, reviewSubagent: null, implementSubagent: null, phaseConfig: null, workerType: 'claude', workerModel: 'opus', workerExtraArgs: null, workerExecutionMode: 'tmux-pipe' as const, workerRuntime: 'tui' as const, createdAt: '', updatedAt: '' })),
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
  return { opts: routeOpts, task };
}

describe('POST /api/tasks/:id/answer — untrusted-input execution gate (Issue #328 sixth-round review)', () => {
  it('blocked by the gate: returns 409, leaves pendingQuestions and task.status untouched, never calls followUp', async () => {
    const originalTask = makeTask();
    const { opts, task } = makeOpts(originalTask, { gateAllows: false });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/1/answer',
      payload: { answers: [{ index: 0, value: 'Option A' }] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'execution_pending_approval' });

    // Nothing was consumed: pendingQuestions survives so the same screen can
    // resubmit once a human approves, and status is whatever
    // enforceExecutionGate itself set (not overwritten by this route).
    expect(task.pendingQuestions).toBe(originalTask.pendingQuestions);
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.followUp).not.toHaveBeenCalled();
    // 'resume_await_answer', not plain 'resume' (Issue #328 seventh-round
    // review symptom A): approving this block must not auto-resume via
    // resumeStateMachine() — see Task.pendingOperation's transition table.
    expect(opts.executeTaskUseCase.enforceExecutionGate).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'resume_await_answer');
  });

  it('allowed by the gate: clears pendingQuestions, logs the answers, and calls followUp with the answer text', async () => {
    const originalTask = makeTask({ executionApprovedFingerprintHash: 'matching-hash' });
    const { opts, task } = makeOpts(originalTask, { gateAllows: true });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/1/answer',
      payload: { answers: [{ index: 0, value: 'Option A' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(task.pendingQuestions).toBeNull();
    expect(opts.executeTaskUseCase.followUp).toHaveBeenCalledTimes(1);
    const [, , followUpComment] = (opts.executeTaskUseCase.followUp as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(followUpComment).toContain('Option A');
  });

  it('a follow-up rejection AFTER the gate passed is not swallowed: logs the failure and marks the task failed', async () => {
    const originalTask = makeTask({ executionApprovedFingerprintHash: 'matching-hash' });
    const { opts, task } = makeOpts(originalTask, { gateAllows: true });
    (opts.executeTaskUseCase.followUp as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tmux window creation failed'));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/1/answer',
      payload: { answers: [{ index: 0, value: 'Option A' }] },
    });

    expect(res.statusCode).toBe(200);

    // Flush the fire-and-forget followUp() rejection's microtask.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(task.status).toBe('failed');
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', expect.objectContaining({ type: 'answer_followup_failed' }));
  });
});
