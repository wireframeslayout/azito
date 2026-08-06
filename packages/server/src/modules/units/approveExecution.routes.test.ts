import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import unitsRoutes from './routes';
import type { UnitsRouteOptions } from './routes';
import type { Task } from '../tasks/Task';
import type { Unit } from './Unit';
import { resolveExecutionManifest, hashExecutionManifest } from '../tasks/execution/ExecutionManifest';

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

/** Computes the same manifest hash the approve-execution route resolves, using this test's own opts mocks (Issue #328 fifth-round review). */
function expectedManifestHash(opts: UnitsRouteOptions, task: Task): string {
  const { manifest } = resolveExecutionManifest(task, {
    unitRepo: opts.unitRepo,
    projectRepo: opts.projectRepo,
    projectServerRepo: opts.projectServerRepo,
    unitTypeLoader: opts.unitTypeLoader,
    sidekickLoader: opts.sidekickLoader,
  });
  return hashExecutionManifest(manifest);
}

function makeOpts(task: Task, unit: Unit): UnitsRouteOptions {
  // Stateful, not a fixed closure over `task`: findById() returns whatever
  // update()/updateStatus() last persisted, same as the real
  // SqliteTaskRepository. This is load-bearing for the restore-staleness
  // regression test below — asserting the object actually passed to
  // restore() is fresh (carries the just-recorded approval hash) only means
  // something if findById() can return a DIFFERENT object than the one this
  // factory started with (Issue #328 fourth-round review finding 1).
  let currentTask: Task = task;

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
      findById: vi.fn((id: number) => (id === task.id ? currentTask : null)),
      create: vi.fn(() => 2),
      update: vi.fn((id: number, data: Partial<Task>) => {
        if (id === task.id) currentTask = { ...currentTask, ...data };
      }),
      updateStatus: vi.fn((id: number, status: Task['status']) => {
        if (id === task.id) currentTask = { ...currentTask, status };
      }),
      updateCurrentPhase: vi.fn(),
      touch: vi.fn(),
      delete: vi.fn(),
      // Mirrors SqliteTaskRepository's real guard (Issue #328 ninth-round
      // review finding 4): only consumes when the CURRENT in-memory task is
      // still 'pending_approval' with a non-null pendingOperation — a second
      // call for the same task (double-submitted approval/denial) sees the
      // first call's clear and returns false, same as the real
      // compare-and-clear UPDATE.
      consumePendingApproval: vi.fn((id: number, fields: { status?: Task['status']; executionApprovedFingerprintHash?: string | null }) => {
        if (id !== task.id) return false;
        if (currentTask.status !== 'pending_approval' || currentTask.pendingOperation === null) return false;
        currentTask = {
          ...currentTask,
          ...(fields.status !== undefined ? { status: fields.status } : {}),
          ...(fields.executionApprovedFingerprintHash !== undefined ? { executionApprovedFingerprintHash: fields.executionApprovedFingerprintHash } : {}),
          pendingOperation: null,
          pendingOperationWindowId: null,
          pendingOperationPriorStatus: null,
        };
        return true;
      }),
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
    projectServerRepo: {
      find: vi.fn(() => null),
    } as unknown as UnitsRouteOptions['projectServerRepo'],
    serverRepo: {
      findByName: vi.fn(() => null),
    } as unknown as UnitsRouteOptions['serverRepo'],
    windowRepo: {
      findById: vi.fn(() => null),
    } as unknown as UnitsRouteOptions['windowRepo'],
    respawnService: {
      respawn: vi.fn(async () => ({ tmuxTarget: 'session:window.1' })),
      resumeLegacySession: vi.fn(async () => ({ windowName: 'task-1' })),
    } as unknown as UnitsRouteOptions['respawnService'],
    sidekickLoader: {} as unknown as UnitsRouteOptions['sidekickLoader'],
    unitTypeLoader: { get: vi.fn(() => null) } as unknown as UnitsRouteOptions['unitTypeLoader'],
    taskRestoreService: {
      restore: vi.fn(async () => ({ tmuxTarget: 'session:window.1', worktreePath: null })),
    } as unknown as UnitsRouteOptions['taskRestoreService'],
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
    const opts = makeOpts(makeTask({ status: 'pending_approval', pendingOperation: 'execute' }), makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: false } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.consumePendingApproval).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('rejection of a blocked restore reverts the task to archived, not failed', async () => {
    // A restore that gets gate-blocked never started anything — denying it
    // should put the task back where it was (archived), not mark it
    // 'failed' (Issue #328 third-round review finding 2).
    const opts = makeOpts(makeTask({ status: 'pending_approval', pendingOperation: 'restore' }), makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: false } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.consumePendingApproval).toHaveBeenCalledWith(1, { status: 'archived' });
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
  });

  it('approval on a never-started task (pendingOperation execute) records the approval hash and calls execute()', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'execute', tmuxWindow: null, description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.consumePendingApproval).toHaveBeenCalledWith(1, { executionApprovedFingerprintHash: expectedManifestHash(opts, task) });
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'open');
    expect(opts.executeTaskUseCase.execute).toHaveBeenCalledWith(20, 1);
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
  });

  it('approval on an already-started task (pendingOperation resume) resumes the state machine instead of re-executing', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'resume', tmuxWindow: 'task-1', description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'running');
    expect(opts.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(20, 1);
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
  });

  it('approval on a blocked restore (pendingOperation restore) resumes restore(), not execute()', async () => {
    // Issue #328 third-round review finding 2: TaskRestoreService.restore()
    // blocks before tmuxWindow is ever set, so the old tmuxWindow-based
    // heuristic indistinguishably matched "never started" — approving used
    // to call execute() instead of restore(), skipping worktree/window
    // reconstruction and starting an unrequested worker run.
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'restore', tmuxWindow: null, description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRestoreService.restore).toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    // restore() manages its own status transition; the approval handler
    // must not preempt it with 'open'/'running'.
    expect(opts.taskRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('approving a gate-blocked restore passes a FRESH task object carrying the just-approved fingerprint, not the stale pre-approval one (Issue #328 fourth-round review finding 1)', async () => {
    // This is the exact regression the fourth-round review flagged: the
    // approval handler used to persist executionApprovedFingerprintHash to
    // the DB but still call restore(task) with the local `task` variable
    // captured BEFORE that write — so restore()'s own checkExecutionGate()
    // re-evaluation saw executionApprovedFingerprintHash still null and
    // immediately re-threw ExecutionGatePendingApprovalError, silently
    // undoing the approval (the caller's .catch(() => {}) swallowed it).
    // Asserting the object passed to restore() actually carries the fresh
    // hash — not the stale `task.executionApprovedFingerprintHash === null`
    // — proves restore() would NOT re-hit the gate.
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'restore', tmuxWindow: null, description: 'do the thing', executionApprovedFingerprintHash: null });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    const expectedHash = expectedManifestHash(opts, task);
    expect(expectedHash).not.toBeNull();
    const restoreCall = (opts.taskRestoreService.restore as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(restoreCall[0].executionApprovedFingerprintHash).toBe(expectedHash);
    expect(restoreCall[0].pendingOperation).toBeNull();
  });

  it('409s instead of guessing an operation when pendingOperation is NULL (Issue #328 ninth-round review finding 4: the tmuxWindow-based fallback this replaced could not tell operations apart and widened the blast radius of a double-submission race)', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: null, tmuxWindow: 'task-1', description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(409);
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
    expect(opts.taskRepo.consumePendingApproval).not.toHaveBeenCalled();
  });

  // A genuine double-submission race can't be reproduced by two concurrent
  // `app.inject()` calls in this test harness: the route handler itself is
  // fully synchronous up to its fire-and-forget dispatch (no `await` before
  // it), so under Node's single-threaded event loop the FIRST request always
  // runs to completion — including changing task.status away from
  // 'pending_approval' — before the SECOND request's handler ever starts.
  // The second request would legitimately 400 on the pre-existing "not
  // pending_approval" check, never reaching consumePendingApproval() at all
  // — which demonstrates the same "no double dispatch" property, just via a
  // different (also correct) status code than a true cross-process race
  // would produce. SqliteTaskRepository.test.ts exercises the actual atomic
  // SQL guard directly (real DB, no mock) — that is where the "only the
  // first caller wins" property is actually proven. These two tests instead
  // verify routes.ts's OWN wiring: when consumePendingApproval() reports it
  // lost the race (the scenario a second/losing process would hit), the
  // handler rejects with 409 and never dispatches anything.
  it('rejects with 409 and dispatches nothing when consumePendingApproval() reports the approval was already consumed (the losing side of a race)', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'execute', tmuxWindow: null, description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    (opts.taskRepo.consumePendingApproval as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(409);
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
  });

  it('rejects a DENIAL with 409 and applies no side effects when consumePendingApproval() reports it was already consumed', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'execute', tmuxWindow: null, description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    (opts.taskRepo.consumePendingApproval as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: false } });

    expect(res.statusCode).toBe(409);
    expect(opts.taskRepo.consumePendingApproval).toHaveBeenCalledWith(1, { status: 'failed' });
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

  it('approval on a blocked respawn (pendingOperation respawn) resumes respawnService.respawn() against the recorded windowId, not resumeStateMachine (Issue #328 fourth-round review finding 2)', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'respawn', pendingOperationWindowId: 5, pendingOperationPriorStatus: 'running', description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    (opts.windowRepo.findById as ReturnType<typeof vi.fn>) = vi.fn((id: number) => (id === 5 ? { id: 5, serverName: 'test-server' } : null));
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>) = vi.fn((name: string) => (name === 'test-server' ? { name: 'test-server', type: 'local' } : null));
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.respawnService.respawn).toHaveBeenCalledWith(5, expect.objectContaining({ name: 'test-server' }));
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
    // respawn() itself never touches task.status — the approval handler must
    // restore it to pendingOperationPriorStatus on success, or the task is
    // stuck showing 'pending_approval' forever despite a successful respawn
    // (Issue #328 seventh-round review symptom B).
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'running');
  });

  it('marks the task failed when an approved respawn cannot find its recorded window (Issue #328 fourth-round review finding 2)', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'respawn', pendingOperationWindowId: 999 });
    const opts = makeOpts(task, makeUnit());
    (opts.windowRepo.findById as ReturnType<typeof vi.fn>) = vi.fn(() => null);
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    expect(opts.respawnService.respawn).not.toHaveBeenCalled();
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', expect.objectContaining({ type: 'approved_operation_failed', operation: 'respawn' }));
  });

  it('approval on a blocked legacy recover-session (pendingOperation recover_session_legacy) resumes resumeLegacySession(), not execute() (Issue #328 fourth-round review finding 2)', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'recover_session_legacy', pendingOperationPriorStatus: 'running', serverName: 'test-server', agentSessionId: 'sess-1' });
    const opts = makeOpts(task, makeUnit());
    (opts.serverRepo.findByName as ReturnType<typeof vi.fn>) = vi.fn((name: string) => (name === 'test-server' ? { name: 'test-server', type: 'local' } : null));
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.respawnService.resumeLegacySession).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'test-server' }));
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.respawnService.respawn).not.toHaveBeenCalled();
    // Same reasoning as respawn above: resumeLegacySession() never touches
    // task.status either (Issue #328 seventh-round review symptom B).
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'running');
  });

  it("approval of a blocked answer-resubmit (pendingOperation resume_await_answer) restores the task to its prior waiting status WITHOUT auto-resuming (Issue #328 seventh-round review symptom A)", async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'resume_await_answer', pendingOperationPriorStatus: 'waiting_input', description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    // The human's answers were never persisted before the block — approving
    // must NOT resume the worker on its own; it must go back to waiting so
    // the human can resubmit POST /api/tasks/:id/answer.
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'waiting_input');
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.followUp).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
  });

  it("approval of a blocked plan-review-resubmit (pendingOperation resume_await_plan_review) restores the task to 'phase_review' WITHOUT auto-resuming (Issue #328 seventh-round review symptom A)", async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'resume_await_plan_review', pendingOperationPriorStatus: 'phase_review', description: 'do the thing' });
    const opts = makeOpts(task, makeUnit());
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });

    expect(res.statusCode).toBe(200);
    // The human's plan feedback/decision was never persisted before the
    // block — approving must NOT auto-resume; it must go back to
    // 'phase_review' so the human can resubmit POST /api/units/:id/approve-plan.
    expect(opts.taskRepo.updateStatus).toHaveBeenCalledWith(1, 'phase_review');
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.followUp).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
  });

  it('logs the failure and marks the task failed when an approved execute() rejects, instead of silently swallowing it (Issue #328 fourth-round review finding 1)', async () => {
    // Previously `.catch(() => {})` — a rejection here vanished with no log
    // entry and no status change, so an approval could silently do nothing.
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'execute' });
    const opts = makeOpts(task, makeUnit());
    (opts.executeTaskUseCase.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('worktree boom'));
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', expect.objectContaining({ type: 'approved_operation_failed', operation: 'execute', message: 'worktree boom' }));
  });

  it('logs the failure and marks the task failed when an approved restore() rejects', async () => {
    const task = makeTask({ status: 'pending_approval', pendingOperation: 'restore' });
    const opts = makeOpts(task, makeUnit());
    (opts.taskRestoreService.restore as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('worktree gone'));
    const app = Fastify();
    await app.register(unitsRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/units/20/approve-execution', payload: { taskId: 1, approved: true } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', expect.objectContaining({ type: 'approved_operation_failed', operation: 'restore', message: 'worktree gone' }));
  });
});
