import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import unitsRoutes from './routes';
import type { UnitsRouteOptions } from './routes';
import type { Task } from '../tasks/Task';
import type { Unit } from './Unit';
import { hashTaskDescription } from '../tasks/execution/ExecutionGate';

// POST /api/units/:id/approve-execution — the human decision point for the
// untrusted-input execution gate (Issue #328), mirroring approve-plan's
// shape (taskId + approved [+ feedback there / no feedback concept here]).

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Test task',
    description: 'do the thing',
    status: 'pending_approval',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
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
    executionApprovedDescriptionHash: null,
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

function makeOpts(task: Task, unit: Unit): UnitsRouteOptions {
  return {
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
      findById: vi.fn((id: number) => (id === task.id ? task : null)),
      create: vi.fn(() => 2),
      update: vi.fn(),
      updateStatus: vi.fn(),
      updateCurrentPhase: vi.fn(),
      touch: vi.fn(),
      delete: vi.fn(),
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
    } as unknown as UnitsRouteOptions['executeTaskUseCase'],
    // defaultUnitId: null so the mismatch check falls back purely to
    // task.unitId (set per-test via makeTask({ unitId })) — no test here
    // relies on the project-default fallback path.
    projectRepo: {
      findById: vi.fn(() => ({ id: task.projectId, defaultUnitId: null })),
    } as unknown as UnitsRouteOptions['projectRepo'],
    sidekickLoader: {} as unknown as UnitsRouteOptions['sidekickLoader'],
    unitTypeLoader: { get: vi.fn(() => null) } as unknown as UnitsRouteOptions['unitTypeLoader'],
  };
}

describe('POST /api/units/:id/approve-execution (Issue #328)', () => {
  it('400s when the task is not pending_approval', async () => {
    const opts = makeOpts(makeTask({ status: 'open' }), makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(400);
  });

  it('rejection: marks the task failed and does not resume execution', async () => {
    const opts = makeOpts(makeTask({ status: 'pending_approval' }), makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: false } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('approval on a never-started task (no tmuxWindow) records the approval hash and calls execute()', async () => {
    const task = makeTask({ status: 'pending_approval', tmuxWindow: null, description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { executionApprovedDescriptionHash: hashTaskDescription('do the thing') });
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'open');
    expect(opts.executeTaskUseCase.execute).toHaveBeenCalledWith(20, 1);
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('approval on an already-started task (tmuxWindow set) resumes the state machine instead of re-executing', async () => {
    const task = makeTask({ status: 'pending_approval', tmuxWindow: 'task-1', description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'running');
    expect(opts.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(20, 1);
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
  });

  it('rejects a string "false" for approved instead of treating it as truthy approval', async () => {
    // `approved: "false"` used to pass the old `approved === undefined`
    // check and then evaluate truthy in `if (!approved)`, silently approving
    // execution (Issue #328 review).
    const opts = makeOpts(makeTask({ status: 'pending_approval' }), makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: 'false' } });

    expect(res.statusCode).toBe(400);
    expect(opts.taskRepo.updateStatus).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
  });

  it('rejects a taskId that is not a positive integer', async () => {
    const opts = makeOpts(makeTask({ status: 'pending_approval' }), makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: -1, approved: true } });

    expect(res.statusCode).toBe(400);
    expect(opts.taskRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('rejects when the task belongs to a different unit than the route id', async () => {
    // Task belongs to unit 20 (makeTask default), but the request addresses
    // unit 99 — must not approve/resume against the wrong unit.
    const task = makeTask({ status: 'pending_approval', unitId: 20 });
    const opts = makeOpts(task, makeUnit({ id: 99 }));
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/99/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(400);
    expect(opts.taskRepo.updateStatus).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
  });
});
