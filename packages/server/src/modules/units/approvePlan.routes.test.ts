import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import unitsRoutes from './routes';
import type { UnitsRouteOptions } from './routes';
import type { Task } from '../tasks/Task';
import type { Unit } from './Unit';
import { ExecutionGatePendingApprovalError } from '../tasks/execution/ExecutionGate';

// POST /api/units/:id/approve-plan — Issue #328 sixth-round review finding 1:
// the "rejected with feedback" and "approved" branches used to mutate
// task.status/currentPhase (and, for rejection, persist `feedback` into
// planMarkdown for the approved branch only — rejection feedback was never
// persisted anywhere) and THEN fire followUp()/resumeStateMachine() with
// `.catch(() => {})`. A gate block on that fire-and-forget call silently
// discarded `feedback` and left the task in a status that didn't match what
// actually happened. These tests assert the fix: the gate is checked
// synchronously first, before either branch mutates task state.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Test task',
    description: 'do the thing',
    status: 'phase_review',
    currentPhase: 'planning',
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: 'task-1',
    selfReviewMaxAttempts: null,
    requirePlanApproval: true,
    source: 'github',
    sourceRef: 'owner/repo#1',
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

function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 20,
    name: 'unit',
    unitType: 'devops',
    systemPrompt: null,
    selfReviewMaxAttempts: 2,
    reviewSubagent: null,
    implementSubagent: null,
    phaseConfig: null,
    workerType: null,
    workerModel: null,
    workerExtraArgs: null,
    workerExecutionMode: 'tmux-pipe',
    workerRuntime: 'tui',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(task: Task, unit: Unit, opts: { gateAllows: boolean }): { opts: UnitsRouteOptions; currentTask: () => Task } {
  let currentTask: Task = task;
  const enforceExecutionGate = vi.fn(() => {
    if (!opts.gateAllows) throw new ExecutionGatePendingApprovalError(task.id);
    return { project: null, projectServer: null };
  });

  const routeOpts: UnitsRouteOptions = {
    unitRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn((id: number) => (id === unit.id ? unit : null)),
      create: vi.fn(() => unit.id),
      update: vi.fn(),
      delete: vi.fn(),
    },
    taskRepo: {
      findAll: vi.fn(() => []),
      findByProject: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn((id: number) => (id === task.id ? currentTask : null)),
      create: vi.fn(() => 2),
      update: vi.fn((id: number, data: Partial<Task>) => {
        if (id === task.id) currentTask = { ...currentTask, ...data };
      }),
      updateStatus: vi.fn((id: number, status: Task['status']) => {
        if (id === task.id) currentTask = { ...currentTask, status };
      }),
      updateCurrentPhase: vi.fn((id: number, phase: string) => {
        if (id === task.id) currentTask = { ...currentTask, currentPhase: phase };
      }),
      touch: vi.fn(),
      delete: vi.fn(),
      // Not exercised by these approve-plan tests (approve-execution's
      // pendingOperation-consuming path lives in modules/tasks/routes.ts) —
      // stubbed only to satisfy ITaskRepository's shape.
      consumePendingApproval: vi.fn(() => false),
      recordExecutionGateBlock: vi.fn(() => true),
    },
    logRepo: {
      findByTask: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      append: vi.fn(),
    },
    executeTaskUseCase: {
      execute: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      stop: vi.fn(),
      resumeStateMachine: vi.fn(async () => {}),
      enforceExecutionGate,
    } as unknown as UnitsRouteOptions['executeTaskUseCase'],
    projectRepo: {
      findById: vi.fn(() => ({ id: task.projectId, defaultUnitId: null })),
    } as unknown as UnitsRouteOptions['projectRepo'],
    projectServerRepo: {
      find: vi.fn(() => null),
    } as unknown as UnitsRouteOptions['projectServerRepo'],
    serverRepo: {
      findByName: vi.fn(() => ({ name: 'test-server', type: 'local' as const, host: '', agentPort: null, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, createdAt: '' })),
    } as unknown as UnitsRouteOptions['serverRepo'],
    sidekickLoader: {} as unknown as UnitsRouteOptions['sidekickLoader'],
    unitTypeLoader: { get: vi.fn(() => null) } as unknown as UnitsRouteOptions['unitTypeLoader'],
  };
  return { opts: routeOpts, currentTask: () => currentTask };
}

describe('POST /api/units/:id/approve-plan — untrusted-input execution gate (Issue #328 sixth-round review)', () => {
  it('rejection with feedback, blocked by the gate: 409s and leaves task.status/currentPhase at phase_review/planning', async () => {
    const task = makeTask({ status: 'phase_review', currentPhase: 'planning' });
    const { opts, currentTask } = makeOpts(task, makeUnit(), { gateAllows: false });
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/units/20/approve-plan',
      payload: { taskId: 1, approved: false, feedback: 'please redo this part' },
    });

    expect(res.statusCode).toBe(409);
    expect(currentTask().status).toBe('phase_review');
    expect(currentTask().currentPhase).toBe('planning');
    expect(opts.executeTaskUseCase.followUp).not.toHaveBeenCalled();
  });

  it('rejection with feedback, allowed by the gate: moves to running/planning and calls followUp with the feedback', async () => {
    const task = makeTask({ status: 'phase_review', currentPhase: 'planning' });
    const { opts, currentTask } = makeOpts(task, makeUnit(), { gateAllows: true });
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/units/20/approve-plan',
      payload: { taskId: 1, approved: false, feedback: 'please redo this part' },
    });

    expect(res.statusCode).toBe(200);
    expect(currentTask().status).toBe('running');
    expect(currentTask().currentPhase).toBe('planning');
    expect(opts.executeTaskUseCase.followUp).toHaveBeenCalledWith(20, 1, 'please redo this part');
    // 'resume_await_plan_review', not plain 'resume' (Issue #328 seventh-round
    // review symptom A) — see Task.pendingOperation's transition table.
    expect(opts.executeTaskUseCase.enforceExecutionGate).toHaveBeenCalledWith(expect.anything(), 20, 'resume_await_plan_review');
  });

  it('approval, blocked by the gate: 409s and leaves task.status/currentPhase at phase_review/planning, planMarkdown untouched', async () => {
    const task = makeTask({ status: 'phase_review', currentPhase: 'planning', planMarkdown: 'original plan' });
    const { opts, currentTask } = makeOpts(task, makeUnit(), { gateAllows: false });
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/units/20/approve-plan',
      payload: { taskId: 1, approved: true, feedback: 'one more thing' },
    });

    expect(res.statusCode).toBe(409);
    expect(currentTask().status).toBe('phase_review');
    expect(currentTask().currentPhase).toBe('planning');
    expect(currentTask().planMarkdown).toBe('original plan');
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('approval, allowed by the gate: moves to running/implementing and resumes the state machine', async () => {
    const task = makeTask({ status: 'phase_review', currentPhase: 'planning' });
    const { opts, currentTask } = makeOpts(task, makeUnit(), { gateAllows: true });
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/units/20/approve-plan',
      payload: { taskId: 1, approved: true },
    });

    expect(res.statusCode).toBe(200);
    expect(currentTask().status).toBe('running');
    expect(currentTask().currentPhase).toBe('implementing');
    expect(opts.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(20, 1);
    // 'resume_await_plan_review', not plain 'resume' (Issue #328 seventh-round
    // review symptom A) — see Task.pendingOperation's transition table.
    expect(opts.executeTaskUseCase.enforceExecutionGate).toHaveBeenCalledWith(expect.anything(), 20, 'resume_await_plan_review');
  });

  it('full rejection (no feedback) never checks the gate — no worker is resumed either way', async () => {
    const task = makeTask({ status: 'phase_review', currentPhase: 'planning' });
    const { opts, currentTask } = makeOpts(task, makeUnit(), { gateAllows: false });
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/units/20/approve-plan',
      payload: { taskId: 1, approved: false },
    });

    expect(res.statusCode).toBe(200);
    expect(currentTask().status).toBe('failed');
    expect(opts.executeTaskUseCase.enforceExecutionGate).not.toHaveBeenCalled();
  });
});
