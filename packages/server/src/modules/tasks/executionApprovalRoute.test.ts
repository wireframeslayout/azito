import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task } from './Task';
import { resolveExecutionManifest, hashExecutionManifest } from './execution/ExecutionManifest';
import { checkExecutionGate } from './execution/ExecutionGate';
import { buildRespawnManifestInput } from '../windows/WindowRespawnService';

// GET /api/tasks/:id/execution-approval (Issue #51) — the browser-facing
// read API for what the untrusted-input execution gate blocked and what a
// human needs to see before approving/denying it. Covers: 404 when the task
// isn't currently pending_approval (nothing live to approve), the 200 shape
// when it is, that secret VALUES never appear (names only), and that the
// resolved execution context (unit/server/branches/phases) comes through.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Imported issue task',
    description: 'Attacker-controlled body from GitHub issue #42',
    status: 'pending_approval',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: true,
    source: 'github',
    sourceRef: 'owner/repo#42',
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: 'main',
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: 'task-1-branch',
    planMarkdown: null,
    pendingQuestions: null,
    changedFiles: null,
    summaryJson: null,
    prUrl: null,
    agentSessionId: null,
    inputTrust: 'untrusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: 'execute',
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: 'open',
    createdByKind: 'operator',
    createdById: null,
    createdViaGeneration: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(existingTask: Task | null): TasksRouteOptions {
  return {
    taskRepo: {
      findAll: vi.fn(() => []),
      findByProject: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn((id: number) => (existingTask && id === existingTask.id ? existingTask : null)),
      create: vi.fn(() => 2),
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
    },
    projectRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, servers: [], repositories: [{ id: 1, provider: 'github' as const, url: 'https://github.com/o/r', owner: 'o', repoName: 'r', name: 'o/r', hasToken: false }], windows: [], createdAt: '', updatedAt: '' })),
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
      findById: vi.fn(() => ({ id: 20, name: 'Devops Unit', unitType: 'devops', systemPrompt: null, selfReviewMaxAttempts: 2, reviewSubagent: null, implementSubagent: null, phaseConfig: null, workerType: 'claude', workerModel: 'opus', workerExtraArgs: null, workerExecutionMode: 'tmux-pipe' as const, workerRuntime: 'tui' as const, createdAt: '', updatedAt: '' })),
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
      findByServerAndSession: vi.fn(() => []),
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
    unitTypeLoader: {
      getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })),
      get: vi.fn(() => ({
        name: 'devops',
        label: 'DevOps',
        description: '',
        phases: [
          { name: 'implementing', label: 'Implementing', tags: ['implementing'], planApproval: false, questions: true, testFailed: false, selfReviewRetry: false, pushVerify: false },
        ],
      })),
    } as unknown as TasksRouteOptions['unitTypeLoader'],
    sidekickLoader: {
      findDefaultForTag: vi.fn(() => ({ name: 'implementing-default', dir: '/tmp/does-not-exist', body: 'do the thing', tags: ['implementing'] })),
      findByName: vi.fn(() => undefined),
    } as unknown as TasksRouteOptions['sidekickLoader'],
    projectSecretRepo: {
      findByProject: vi.fn(() => [
        { id: 2, projectId: 10, name: 'GH_TOKEN', createdAt: '' },
        { id: 1, projectId: 10, name: 'API_KEY', createdAt: '' },
      ]),
    } as unknown as TasksRouteOptions['projectSecretRepo'],
    auditLogService: { record: vi.fn() } as unknown as TasksRouteOptions['auditLogService'],
    originationService: { create: vi.fn(() => 1) } as unknown as TasksRouteOptions['originationService'],
    taskTokenRepo: { issue: vi.fn(), verify: vi.fn(() => false), revokeAllForTask: vi.fn(() => 0), issueNextGeneration: vi.fn(), getActiveGeneration: vi.fn(() => null) } as unknown as TasksRouteOptions['taskTokenRepo'],
    revokeTaskWindowGeneration: vi.fn(),
  };
}

/** Stateful task store so consumePendingApproval()/update() mutations are visible to a later findById() in the same test — mirrors modules/units/approveExecution.routes.test.ts's makeOpts pattern. Module-scoped (not describe-local) so both the POST describe block and the GET/POST manifest-consistency describe block below can share it. */
function makeStatefulOpts(initialTask: Task): { opts: TasksRouteOptions; getTask: () => Task } {
  let currentTask: Task = initialTask;
  const opts = makeOpts(initialTask);
  // The base makeOpts() fixture's execute()/followUp() mocks return
  // undefined (no test using them previously awaited/chained on the
  // result) — decideExecutionApproval's dispatch calls `.catch()` on
  // whatever execute()/resumeStateMachine() return, so callers needing
  // that resolved need it to actually resolve.
  opts.executeTaskUseCase = {
    ...opts.executeTaskUseCase,
    execute: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    resumeStateMachine: vi.fn(async () => {}),
  } as unknown as TasksRouteOptions['executeTaskUseCase'];
  opts.taskRepo.findById = vi.fn((id: number) => (id === initialTask.id ? currentTask : null));
  opts.taskRepo.update = vi.fn((id: number, data: Partial<Task>) => {
    if (id === initialTask.id) currentTask = { ...currentTask, ...data };
  });
  opts.taskRepo.updateStatus = vi.fn((id: number, status: Task['status']) => {
    if (id === initialTask.id) currentTask = { ...currentTask, status };
  });
  opts.taskRepo.consumePendingApproval = vi.fn((id: number, fields: { status?: Task['status']; executionApprovedFingerprintHash?: string }) => {
    if (id !== initialTask.id) return false;
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
  });
  opts.taskRepo.preApproveExecution = vi.fn((id: number, fingerprintHash: string) => {
    if (id !== initialTask.id) return false;
    if (currentTask.status !== 'open' || currentTask.pendingOperation !== null || currentTask.inputTrust !== 'untrusted') return false;
    currentTask = { ...currentTask, executionApprovedFingerprintHash: fingerprintHash };
    return true;
  });
  return { opts, getTask: () => currentTask };
}

/** Module-scoped fingerprint helper (mirrors the POST describe block's own `currentFingerprint`, which is scoped to that block) — resolves via the SAME resolveExecutionManifest/hashExecutionManifest pair every route handler uses, for tests outside that block (the pre-approval describe below). No respawn support — pre-approval never applies to a respawn-blocked task. */
function currentFingerprintFor(opts: TasksRouteOptions, task: Task): string {
  const { manifest } = resolveExecutionManifest(task, {
    unitRepo: opts.unitRepo,
    projectRepo: opts.projectRepo,
    projectServerRepo: opts.projectServerRepo,
    serverRepo: opts.serverRepo,
    projectSecretRepo: opts.projectSecretRepo,
    unitTypeLoader: opts.unitTypeLoader,
    sidekickLoader: opts.sidekickLoader,
  });
  return hashExecutionManifest(manifest);
}

describe('GET /api/tasks/:id/execution-approval (Issue #51)', () => {
  it('404s when the task does not exist', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(null));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/999/execution-approval' });
    expect(res.statusCode).toBe(404);
  });

  it('404s when the task exists but is not pending_approval', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeTask({ status: 'open' })));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the resolved execution context and secret NAMES (never values) for a pending_approval task', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeTask()));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toMatchObject({
      taskId: 1,
      title: 'Imported issue task',
      description: 'Attacker-controlled body from GitHub issue #42',
      inputTrust: 'untrusted',
      pendingOperation: 'execute',
      inputPolicy: 'manual-approval',
    });
    expect(body.execution.unitId).toBe(20);
    expect(body.execution.unitName).toBe('Devops Unit');
    expect(body.execution.serverName).toBe('test-server');
    expect(body.execution.workingDirectory).toBe('/work');
    expect(body.execution.branches).toMatchObject({ base: 'main', work: 'task-1-branch' });
    expect(body.execution.phases).toEqual([{ phase: 'implementing', sidekickName: 'implementing-default' }]);
    expect(body.execution.repository).toMatchObject({ provider: 'github', owner: 'o', repoName: 'r' });

    // Names only, sorted — never plaintext values, and never the digest a
    // human can't act on.
    expect(body.secretNames).toEqual(['API_KEY', 'GH_TOKEN']);
    const json = JSON.stringify(body);
    expect(json).not.toContain('namesDigest');

    // Issue #328 review fix 1: the fingerprint returned here is what the
    // client must echo back on approval — must be a real, non-empty hash.
    expect(typeof body.fingerprint).toBe('string');
    expect(body.fingerprint.length).toBeGreaterThan(0);
  });
});

// POST /api/tasks/:id/approve-execution (Issue #328 review) — the task-scoped
// approve/deny endpoint. Two things this endpoint exists to fix, covered
// below: (1) an approval must be tied to the exact manifest fingerprint the
// human saw on the approval screen (fix 1 — a TOCTOU close), and (2) a task
// whose Unit cannot be resolved must still be at least deniable, and
// approvable for operations ('restore') that don't actually need a Unit to
// run (fix 2).
describe('POST /api/tasks/:id/approve-execution (Issue #328 review)', () => {
  /**
   * `respawnWindow` mirrors decideExecutionApproval's own resolution for a
   * blocked 'respawn' operation (it re-resolves via the pending window, not
   * the task's server) — pass the same window object a test's overridden
   * windowRepo.findById() would return, so the fingerprint computed here
   * matches what the handler recomputes at approval time.
   */
  function currentFingerprint(opts: TasksRouteOptions, task: Task, respawnWindow?: { serverName: string; workerModel: string | null; workerType: string | null; paneLayout: null }): string {
    const { manifest } = resolveExecutionManifest(
      task,
      {
        unitRepo: opts.unitRepo,
        projectRepo: opts.projectRepo,
        projectServerRepo: opts.projectServerRepo,
        serverRepo: opts.serverRepo,
        projectSecretRepo: opts.projectSecretRepo,
        unitTypeLoader: opts.unitTypeLoader,
        sidekickLoader: opts.sidekickLoader,
      },
      respawnWindow ? buildRespawnManifestInput(respawnWindow) : undefined,
      respawnWindow?.serverName,
    );
    return hashExecutionManifest(manifest);
  }

  it('404s when the task does not exist', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(null));
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/999/approve-execution', payload: { approved: true, fingerprint: 'whatever' } });
    expect(res.statusCode).toBe(404);
  });

  it('400s an approval with no fingerprint — the whole point of fix 1 is that approval must be tied to a specific manifest', async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(task));
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true } });
    expect(res.statusCode).toBe(400);
  });

  it('approves with the CURRENT fingerprint and dispatches the pending operation', async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const { opts, getTask } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    expect(getTask().executionApprovedFingerprintHash).toBe(fingerprint);
    expect(getTask().pendingOperation).toBeNull();
    expect(opts.executeTaskUseCase.execute).toHaveBeenCalledWith(20, 1);
  });

  it('a STALE fingerprint (task edited after the approval screen loaded) is rejected with 409 and consumes nothing', async () => {
    const task = makeTask({ pendingOperation: 'execute', title: 'Original title' });
    const { opts, getTask } = makeStatefulOpts(task);
    const staleFingerprint = currentFingerprint(opts, task);
    // Simulate the task's content changing after the human loaded the
    // approval screen but before they clicked approve — same field this
    // manifest fingerprints (title reaches the worker's prompt).
    opts.taskRepo.findById = vi.fn((id: number) => (id === task.id ? { ...task, title: 'Rewritten by someone else' } : null));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint: staleFingerprint } });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('fingerprint_mismatch');
    expect(opts.taskRepo.consumePendingApproval).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    // Task is still exactly as it was — approval was neither consumed nor
    // silently re-sent against the new content.
    expect(getTask().status).toBe('pending_approval');
  });

  it('a task whose Unit cannot be resolved can still be DENIED (Issue #328 review fix 2 — deny must never get stuck)', async () => {
    const task = makeTask({ unitId: null, pendingOperation: 'restore', pendingOperationPriorStatus: 'archived' });
    const { opts, getTask } = makeStatefulOpts(task);
    // No unit_id on the task and no defaultUnitId on the project — the Unit
    // is genuinely unresolvable.
    opts.projectRepo.findById = vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], repositories: [], windows: [], createdAt: '', updatedAt: '' }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: false } });

    expect(res.statusCode).toBe(200);
    expect(getTask().status).toBe('archived');
    expect(getTask().pendingOperation).toBeNull();
  });

  it("a task whose Unit cannot be resolved can still be APPROVED for a 'restore' (which does not need a Unit to run)", async () => {
    const task = makeTask({ unitId: null, pendingOperation: 'restore', pendingOperationPriorStatus: 'archived' });
    const { opts, getTask } = makeStatefulOpts(task);
    opts.projectRepo.findById = vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], repositories: [], windows: [], createdAt: '', updatedAt: '' }));
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRestoreService.restore).toHaveBeenCalled();
    expect(getTask().pendingOperation).toBeNull();
  });

  it("a task whose Unit cannot be resolved is rejected with 409 (not silently consumed) when approving an 'execute' — that operation genuinely cannot dispatch without a Unit", async () => {
    const task = makeTask({ unitId: null, pendingOperation: 'execute' });
    const { opts, getTask } = makeStatefulOpts(task);
    opts.projectRepo.findById = vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: null, servers: [], repositories: [], windows: [], createdAt: '', updatedAt: '' }));
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(409);
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    // Not consumed — the task remains pending_approval, so a human can fix
    // the Unit assignment and retry, or still deny it.
    expect(getTask().status).toBe('pending_approval');
    expect(getTask().pendingOperation).toBe('execute');
  });

  // The tests below port modules/units/approveExecution.routes.test.ts's
  // per-operation dispatch coverage (Issue #328 hardening follow-up): that
  // file exercised POST /api/units/:id/approve-execution, which was removed
  // because it reached decideExecutionApproval() without requiring
  // `fingerprint`. Since this route dispatches through the exact same
  // decideExecutionApproval(), the operation-dispatch behavior it proves
  // (resume/restore/respawn/recover_session_legacy/resume_await_*, race
  // handling, failure logging) still needs coverage — now against this,
  // the only remaining entry point.

  it('409s instead of guessing an operation when pendingOperation is NULL', async () => {
    const task = makeTask({ pendingOperation: null });
    const opts = makeOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(409);
    expect(opts.taskRepo.consumePendingApproval).not.toHaveBeenCalled();
  });

  it('rejects with 409 and dispatches nothing when consumePendingApproval() reports the approval was already consumed (the losing side of a race)', async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const opts = makeOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    // The base fixture's consumePendingApproval already returns false —
    // simulating the losing side of a concurrent approval.
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(409);
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.logRepo.append).not.toHaveBeenCalledWith(1, 20, 'status_change', { status: 'execution_approved' });
  });

  it('rejects a DENIAL with 409 and applies no side effects when consumePendingApproval() reports it was already consumed', async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const opts = makeOpts(task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: false } });

    expect(res.statusCode).toBe(409);
    expect(opts.taskRepo.consumePendingApproval).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(opts.logRepo.append).not.toHaveBeenCalledWith(1, 20, 'status_change', { status: 'execution_denied' });
  });

  it('logs execution_approved only AFTER consumePendingApproval() succeeds', async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const callOrder: string[] = [];
    const originalConsumeImpl = (opts.taskRepo.consumePendingApproval as ReturnType<typeof vi.fn>).getMockImplementation() as
      (id: number, fields: { status?: Task['status']; executionApprovedFingerprintHash?: string }) => boolean;
    (opts.taskRepo.consumePendingApproval as ReturnType<typeof vi.fn>).mockImplementation((id: number, fields: { status?: Task['status']; executionApprovedFingerprintHash?: string }) => {
      callOrder.push('consumePendingApproval');
      return originalConsumeImpl(id, fields);
    });
    // 'execution_approved' is now logged as a 'command' entry, not a
    // 'status_change' one (Issue #328 review round fix 3) — it is audit-only,
    // never a real task.status value (see decideExecutionApproval's own
    // comment on why: buildServer.ts's NotificationBus/push bridges forward
    // a 'status_change' entry's `content.status` verbatim as the WS
    // `task:status` payload, and a synthetic label there would read as a
    // phantom status to a connected client).
    (opts.logRepo.append as ReturnType<typeof vi.fn>).mockImplementation((_taskId: number, _unitId: number, type: string, content: { type?: string }) => {
      if (type === 'command' && content?.type === 'execution_approved') callOrder.push('logRepo.append(execution_approved)');
    });
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    expect(callOrder).toEqual(['consumePendingApproval', 'logRepo.append(execution_approved)']);
  });

  it("logs execution_approved with origin 'mission_prompt' when the /azt-mission orchestrator supplies it", async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint, origin: 'mission_prompt' } });

    expect(res.statusCode).toBe(200);
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', { type: 'execution_approved', origin: 'mission_prompt' });
  });

  it('approval on an already-started task (pendingOperation resume) resumes the state machine instead of re-executing', async () => {
    const task = makeTask({ pendingOperation: 'resume', tmuxWindow: 'task-1' });
    const { opts, getTask } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    expect(getTask().status).toBe('running');
    expect(opts.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(20, 1);
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
  });

  it('approving a gate-blocked restore passes a FRESH task object carrying the just-approved fingerprint, not the stale pre-approval one', async () => {
    // Regression: the approval handler must call restore() with the task as
    // it exists AFTER consumePendingApproval() persists the fingerprint —
    // otherwise restore()'s own gate re-check sees the stale, still-null
    // hash and immediately re-blocks, silently undoing the approval.
    const task = makeTask({ pendingOperation: 'restore', pendingOperationPriorStatus: 'archived', executionApprovedFingerprintHash: null });
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    const restoreCall = (opts.taskRestoreService.restore as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(restoreCall[0].executionApprovedFingerprintHash).toBe(fingerprint);
    expect(restoreCall[0].pendingOperation).toBeNull();
  });

  it('approval on a blocked respawn (pendingOperation respawn) resumes respawnService.respawn() against the recorded windowId, not resumeStateMachine', async () => {
    const task = makeTask({ pendingOperation: 'respawn', pendingOperationWindowId: 5, pendingOperationPriorStatus: 'running' });
    const { opts, getTask } = makeStatefulOpts(task);
    const respawnWindow = { id: 5, serverName: 'test-server', workerModel: null, workerType: null, paneLayout: null };
    opts.windowRepo.findById = vi.fn((id: number) => (id === 5 ? respawnWindow : undefined)) as unknown as TasksRouteOptions['windowRepo']['findById'];
    const fingerprint = currentFingerprint(opts, task, respawnWindow);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.respawnService.respawn).toHaveBeenCalledWith(5, expect.objectContaining({ name: 'test-server' }));
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.taskRestoreService.restore).not.toHaveBeenCalled();
    expect(getTask().status).toBe('running');
  });

  it("respawn approval emits a 'status_change' log entry with the REAL restored status once respawnService.respawn() resolves — not just the audit-only 'execution_approved' entry (Issue #328 review round fix 3)", async () => {
    // Before this fix, respawn's real transition back to priorStatus
    // ('running') was applied via updateStatus() but never logged as a
    // 'status_change' — a client that closed the approval panel on the
    // FIRST (synthetic, pre-transition) event had no further signal that
    // the respawn actually completed.
    const task = makeTask({ pendingOperation: 'respawn', pendingOperationWindowId: 5, pendingOperationPriorStatus: 'running' });
    const { opts } = makeStatefulOpts(task);
    const respawnWindow = { id: 5, serverName: 'test-server', workerModel: null, workerType: null, paneLayout: null };
    opts.windowRepo.findById = vi.fn((id: number) => (id === 5 ? respawnWindow : undefined)) as unknown as TasksRouteOptions['windowRepo']['findById'];
    const fingerprint = currentFingerprint(opts, task, respawnWindow);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));

    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'status_change', { status: 'running', operation: 'respawn' });
  });

  it("rejects with 409 (not a silent fallback to the non-respawn manifest) when a pending respawn's recorded window no longer exists — the manifest cannot be resolved at all, so nothing is consumed", async () => {
    const task = makeTask({ pendingOperation: 'respawn', pendingOperationWindowId: 999 });
    const { opts, getTask } = makeStatefulOpts(task);
    // Default windowRepo.findById returns undefined — the recorded window
    // no longer exists. Previously this silently fell back to resolving the
    // NON-respawn manifest (same bug class as the GET/POST mismatch this
    // round fixes) and only failed later, mid-dispatch, after approval was
    // already consumed. Now resolvePendingApprovalManifest() throws before
    // any state is mutated.
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint: 'irrelevant-manifest-cannot-be-resolved' } });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('pending_operation_window_missing');
    expect(opts.respawnService.respawn).not.toHaveBeenCalled();
    expect(opts.taskRepo.consumePendingApproval).not.toHaveBeenCalled();
    expect(getTask().status).toBe('pending_approval');
    expect(getTask().pendingOperation).toBe('respawn');
  });

  it('approval on a blocked legacy recover-session (pendingOperation recover_session_legacy) resumes resumeLegacySession(), not execute()', async () => {
    const task = makeTask({ pendingOperation: 'recover_session_legacy', pendingOperationPriorStatus: 'running', agentSessionId: 'sess-1' });
    const { opts, getTask } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.respawnService.resumeLegacySession).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'test-server' }));
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    expect(opts.respawnService.respawn).not.toHaveBeenCalled();
    expect(getTask().status).toBe('running');
  });

  it("legacy-recover approval emits a 'status_change' log entry with the REAL restored status once resumeLegacySession() resolves (Issue #328 review round fix 3, same missing-emit gap as respawn)", async () => {
    const task = makeTask({ pendingOperation: 'recover_session_legacy', pendingOperationPriorStatus: 'running', agentSessionId: 'sess-1' });
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));

    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'status_change', { status: 'running', operation: 'recover_session_legacy' });
  });

  it("restore approval emits a 'status_change' log entry with the REAL post-restore status once taskRestoreService.restore() resolves (Issue #328 review round fix 3) — a client refetching on the earlier 'execution_approved' audit entry alone would still see 'pending_approval'", async () => {
    const task = makeTask({ pendingOperation: 'restore', pendingOperationPriorStatus: 'archived', executionApprovedFingerprintHash: null });
    const { opts, getTask } = makeStatefulOpts(task);
    // Mirrors what the REAL TaskRestoreService.restore() does on success —
    // sets status to 'open' before its promise resolves (see
    // TaskRestoreService.ts) — the base fixture's mock doesn't touch
    // task state at all, which would leave currentTask stuck at
    // 'pending_approval' and make this assertion vacuous.
    opts.taskRestoreService.restore = vi.fn(async (t: Task) => {
      opts.taskRepo.update(t.id, { status: 'open' as Task['status'], pendingOperation: null });
      return { tmuxTarget: 'azito:task-1.1', worktreePath: null };
    }) as unknown as TasksRouteOptions['taskRestoreService']['restore'];
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));

    expect(getTask().status).toBe('open');
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'status_change', { status: 'open', operation: 'restore' });
  });

  it("approval of a blocked answer-resubmit (pendingOperation resume_await_answer) restores the task to its prior waiting status WITHOUT auto-resuming", async () => {
    const task = makeTask({ pendingOperation: 'resume_await_answer', pendingOperationPriorStatus: 'waiting_input' });
    const { opts, getTask } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    expect(getTask().status).toBe('waiting_input');
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.followUp).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
    // The transition is applied BEFORE this emits (Issue #328 review round
    // fix 3) — status is the REAL restored value ('waiting_input'), not the
    // synthetic 'execution_approved_awaiting_resubmit' label the log used to
    // carry as its `status` field.
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'status_change', { status: 'waiting_input', operation: 'resume_await_answer', awaitingResubmit: true });
  });

  it("approval of a blocked plan-review-resubmit (pendingOperation resume_await_plan_review) restores the task to 'phase_review' WITHOUT auto-resuming", async () => {
    const task = makeTask({ pendingOperation: 'resume_await_plan_review', pendingOperationPriorStatus: 'phase_review' });
    const { opts, getTask } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    expect(getTask().status).toBe('phase_review');
    expect(opts.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.followUp).not.toHaveBeenCalled();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
  });

  it('logs the failure and marks the task failed when an approved execute() rejects, instead of silently swallowing it', async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    (opts.executeTaskUseCase.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('worktree boom'));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', expect.objectContaining({ type: 'approved_operation_failed', operation: 'execute', message: 'worktree boom' }));
    // Issue #328 review round: the 'failed' transition itself must be logged
    // as a 'status_change' entry AND emitted on the shared task-events bus —
    // not just the 'command' entry above — so other connected clients get a
    // live `task:status` WS notification instead of seeing a stale status
    // until their next manual refresh.
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'status_change', expect.objectContaining({ status: 'failed', operation: 'execute' }));
    expect(opts.executeTaskUseCase.events.emit).toHaveBeenCalledWith('log', expect.objectContaining({
      taskId: 1, unitId: 20, type: 'status_change', content: expect.objectContaining({ status: 'failed', operation: 'execute' }),
    }));
  });

  // Issue #328 review round, fix 2: before this fix, consumePendingApproval()
  // cleared pendingOperation/pendingOperationWindowId/pendingOperationPriorStatus
  // while leaving `status` at 'pending_approval' — the REAL transition only
  // landed later, from restore()/respawn()/resumeLegacySession()'s own async
  // success callback. A crash (process kill, unhandled rejection, log-write
  // failure) between those two points left the row stuck at
  // status='pending_approval' with pendingOperation=null: re-approval is
  // impossible (decideExecutionApproval's own guard 409s with "no
  // pendingOperation recorded" — see the check right after `operation` is
  // read), and the SAME check makes a second approve/deny attempt reject too.
  // These tests model that crash by making the dispatched operation's promise
  // never settle (simulating the process dying mid-dispatch, before
  // taskRestoreService.restore()/respawnService.respawn() ever get a chance to
  // resolve or reject) and assert the row is NEVER left with
  // status='pending_approval' AND pendingOperation=null at the same time —
  // removing this fix's `status: nextStatus` argument from the
  // consumePendingApproval() call in ExecutionApprovalDecision.ts makes every
  // test in this block fail.
  describe('Issue #328 review round fix 2 — no crash window between approval consumption and dispatch completion', () => {
    it('a restore approval whose dispatch never settles still leaves the row recoverable (archived, not pending_approval-with-no-pendingOperation)', async () => {
      const task = makeTask({ pendingOperation: 'restore', pendingOperationPriorStatus: 'archived', executionApprovedFingerprintHash: null });
      const { opts, getTask } = makeStatefulOpts(task);
      // Simulates the process dying mid-restore(): the promise never
      // resolves or rejects, so no success/failure callback ever runs.
      opts.taskRestoreService.restore = vi.fn(() => new Promise(() => {})) as unknown as TasksRouteOptions['taskRestoreService']['restore'];
      const fingerprint = currentFingerprint(opts, task);
      const app = Fastify();
      await app.register(tasksRoutes, opts);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

      expect(res.statusCode).toBe(200);
      // The dangerous window this fix closes: status must NOT still be
      // 'pending_approval' now that pendingOperation has already been
      // cleared — that combination is exactly "looks like it needs approval,
      // but nothing is left to approve".
      expect(getTask().pendingOperation).toBeNull();
      expect(getTask().status).not.toBe('pending_approval');
      expect(getTask().status).toBe('archived');
    });

    it('a respawn approval whose dispatch never settles still leaves the row at its (recoverable) priorStatus, not pending_approval-with-no-pendingOperation', async () => {
      const task = makeTask({ pendingOperation: 'respawn', pendingOperationWindowId: 5, pendingOperationPriorStatus: 'running' });
      const { opts, getTask } = makeStatefulOpts(task);
      const respawnWindow = { id: 5, serverName: 'test-server', workerModel: null, workerType: null, paneLayout: null };
      opts.windowRepo.findById = vi.fn((id: number) => (id === 5 ? respawnWindow : undefined)) as unknown as TasksRouteOptions['windowRepo']['findById'];
      // Simulates the process dying mid-respawn(): the promise never settles.
      opts.respawnService.respawn = vi.fn(() => new Promise(() => {})) as unknown as TasksRouteOptions['respawnService']['respawn'];
      const fingerprint = currentFingerprint(opts, task, respawnWindow);
      const app = Fastify();
      await app.register(tasksRoutes, opts);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

      expect(res.statusCode).toBe(200);
      expect(getTask().pendingOperation).toBeNull();
      expect(getTask().status).not.toBe('pending_approval');
      // 'running' is a RECOVERABLE_STATUSES value (RecoverStuckTasksUseCase),
      // so this crash is now caught by ordinary startup recovery instead of
      // being unrecoverable.
      expect(getTask().status).toBe('running');
    });

    it("a resume_await_answer approval (synchronous, no async dispatch) never has a pending_approval-with-no-pendingOperation window either", async () => {
      const task = makeTask({ pendingOperation: 'resume_await_answer', pendingOperationPriorStatus: 'waiting_input' });
      const { opts, getTask } = makeStatefulOpts(task);
      const fingerprint = currentFingerprint(opts, task);
      const app = Fastify();
      await app.register(tasksRoutes, opts);
      await app.ready();

      const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

      expect(res.statusCode).toBe(200);
      expect(getTask().pendingOperation).toBeNull();
      expect(getTask().status).toBe('waiting_input');
    });
  });

  it('logs the failure and marks the task failed when an approved restore() rejects', async () => {
    const task = makeTask({ pendingOperation: 'restore' });
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprint(opts, task);
    (opts.taskRestoreService.restore as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('worktree gone'));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, { status: 'failed' });
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', expect.objectContaining({ type: 'approved_operation_failed', operation: 'restore', message: 'worktree gone' }));
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'status_change', expect.objectContaining({ status: 'failed', operation: 'restore' }));
    expect(opts.executeTaskUseCase.events.emit).toHaveBeenCalledWith('log', expect.objectContaining({
      taskId: 1, unitId: 20, type: 'status_change', content: expect.objectContaining({ status: 'failed', operation: 'restore' }),
    }));
  });
});

// Issue #328 fourteenth-round review: GET .../execution-approval and POST
// .../approve-execution must resolve the SAME manifest for every
// pendingOperation, so the fingerprint a human reads off the GET response is
// always the one the POST handler re-hashes and accepts. Before this round,
// GET always resolved the non-respawn manifest while POST additionally
// folded in `buildRespawnManifestInput(window)` + the window's own
// serverName whenever `pendingOperation === 'respawn'` — the two manifests
// differed, so the fingerprint GET displayed could never satisfy POST's
// check, and a respawn-blocked task could never be approved. These tests
// exercise the real HTTP round trip (GET, then POST with exactly the
// fingerprint GET returned) for every pendingOperation value, so a
// reintroduced GET/POST resolution mismatch fails here instead of only
// being caught in production.
describe('GET fingerprint satisfies POST (Issue #328 fourteenth-round review — one operation at a time)', () => {
  async function approveWithGetFingerprint(opts: TasksRouteOptions): Promise<{ getRes: { statusCode: number }; postRes: { statusCode: number; json: () => Record<string, unknown> } }> {
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const getRes = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });
    const fingerprint = getRes.json().fingerprint as string;
    const postRes = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });
    await new Promise((r) => setImmediate(r));
    return { getRes, postRes };
  }

  it("'execute'", async () => {
    const task = makeTask({ pendingOperation: 'execute' });
    const { opts } = makeStatefulOpts(task);
    const { getRes, postRes } = await approveWithGetFingerprint(opts);
    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
    expect(opts.executeTaskUseCase.execute).toHaveBeenCalledWith(20, 1);
  });

  it("'resume'", async () => {
    const task = makeTask({ pendingOperation: 'resume', tmuxWindow: 'task-1' });
    const { opts, getTask } = makeStatefulOpts(task);
    const { getRes, postRes } = await approveWithGetFingerprint(opts);
    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
    expect(opts.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(20, 1);
    expect(getTask().status).toBe('running');
  });

  it("'restore'", async () => {
    const task = makeTask({ pendingOperation: 'restore', pendingOperationPriorStatus: 'archived' });
    const { opts } = makeStatefulOpts(task);
    const { getRes, postRes } = await approveWithGetFingerprint(opts);
    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
    expect(opts.taskRestoreService.restore).toHaveBeenCalled();
  });

  it("'recover_session_legacy'", async () => {
    const task = makeTask({ pendingOperation: 'recover_session_legacy', pendingOperationPriorStatus: 'running', agentSessionId: 'sess-1' });
    const { opts, getTask } = makeStatefulOpts(task);
    const { getRes, postRes } = await approveWithGetFingerprint(opts);
    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
    expect(opts.respawnService.resumeLegacySession).toHaveBeenCalledWith(1, expect.objectContaining({ name: 'test-server' }));
    expect(getTask().status).toBe('running');
  });

  it("'resume_await_answer'", async () => {
    const task = makeTask({ pendingOperation: 'resume_await_answer', pendingOperationPriorStatus: 'waiting_input' });
    const { opts, getTask } = makeStatefulOpts(task);
    const { getRes, postRes } = await approveWithGetFingerprint(opts);
    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
    expect(getTask().status).toBe('waiting_input');
  });

  it("'resume_await_plan_review'", async () => {
    const task = makeTask({ pendingOperation: 'resume_await_plan_review', pendingOperationPriorStatus: 'phase_review' });
    const { opts, getTask } = makeStatefulOpts(task);
    const { getRes, postRes } = await approveWithGetFingerprint(opts);
    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
    expect(getTask().status).toBe('phase_review');
  });

  it("'respawn' — the operation the GET/POST manifest mismatch bug actually broke", async () => {
    const task = makeTask({ pendingOperation: 'respawn', pendingOperationWindowId: 5, pendingOperationPriorStatus: 'running' });
    const { opts, getTask } = makeStatefulOpts(task);
    const respawnWindow = { id: 5, serverName: 'test-server', workerModel: null, workerType: null, paneLayout: null };
    opts.windowRepo.findById = vi.fn((id: number) => (id === 5 ? respawnWindow : undefined)) as unknown as TasksRouteOptions['windowRepo']['findById'];
    const { getRes, postRes } = await approveWithGetFingerprint(opts);
    expect(getRes.statusCode).toBe(200);
    // Before this round's fix, this was ALWAYS 409 fingerprint_mismatch —
    // GET resolved a different manifest than POST re-hashed.
    expect(postRes.statusCode).toBe(200);
    expect(opts.respawnService.respawn).toHaveBeenCalledWith(5, expect.objectContaining({ name: 'test-server' }));
    expect(getTask().status).toBe('running');
  });

  it("GET 409s (does not display a stale/wrong manifest) when a pending respawn's recorded window no longer exists", async () => {
    const task = makeTask({ pendingOperation: 'respawn', pendingOperationWindowId: 999 });
    const opts = makeOpts(task);
    // Default windowRepo.findById returns undefined.
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('pending_operation_window_missing');
  });
});

// Creation-time pre-approval (task/328-input-trust-and-exec-gate follow-up,
// part A): a freshly created untrusted task — still status='open',
// pendingOperation NULL, i.e. it has NEVER been gate-blocked — can be
// pre-approved directly by the interactive create-form flow, without ever
// entering pending_approval or dispatching a worker. Both GET
// .../execution-approval (now additionally serving this state) and POST
// .../approve-execution (branching to decideExecutionPreApproval instead of
// decideExecutionApproval) are covered together, since the create-form flow
// always calls them as a pair (fetch fingerprint, then approve with it).
describe('Creation-time pre-approval (task/328 follow-up)', () => {
  function makeOpenTask(overrides: Partial<Task> = {}): Task {
    return makeTask({
      status: 'open',
      pendingOperation: null,
      pendingOperationWindowId: null,
      pendingOperationPriorStatus: null,
      executionApprovedFingerprintHash: null,
      ...overrides,
    });
  }

  it('GET returns a live manifest/fingerprint for a fresh open untrusted task (not just pending_approval ones)', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeOpenTask()));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pendingOperation).toBeNull();
    expect(typeof body.fingerprint).toBe('string');
    expect(body.fingerprint.length).toBeGreaterThan(0);
  });

  it('GET still 404s for a fresh open TRUSTED task — nothing to pre-approve', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeOpenTask({ inputTrust: 'trusted', source: 'local', sourceRef: null })));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });

    expect(res.statusCode).toBe(404);
  });

  it('POST approves with the current fingerprint, records it, and dispatches NOTHING — status/pendingOperation stay untouched', async () => {
    const task = makeOpenTask();
    const { opts, getTask } = makeStatefulOpts(task);
    const fingerprint = currentFingerprintFor(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(res.statusCode).toBe(200);
    expect(getTask().executionApprovedFingerprintHash).toBe(fingerprint);
    expect(getTask().status).toBe('open');
    expect(getTask().pendingOperation).toBeNull();
    expect(opts.executeTaskUseCase.execute).not.toHaveBeenCalled();
  });

  it('POST 400s an approval with no fingerprint, same as the pending_approval path', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeOpenTask()));
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true } });

    expect(res.statusCode).toBe(400);
  });

  it('POST rejects a STALE fingerprint with 409 fingerprint_mismatch and writes nothing', async () => {
    const task = makeOpenTask({ title: 'Original title' });
    const { opts, getTask } = makeStatefulOpts(task);
    const staleFingerprint = currentFingerprintFor(opts, task);
    opts.taskRepo.findById = vi.fn((id: number) => (id === task.id ? { ...task, title: 'Rewritten by someone else' } : null));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint: staleFingerprint } });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('fingerprint_mismatch');
    expect(getTask().executionApprovedFingerprintHash).toBeNull();
  });

  it('POST 400s a denial for a fresh open task — there is no pending block to deny', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeOpenTask()));
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: false } });

    expect(res.statusCode).toBe(400);
  });

  it('a later execute() attempt against the pre-approved manifest passes the gate immediately (no pending_approval detour)', async () => {
    // This is the actual point of the feature: once pre-approved, the
    // task's first real execute() call must see
    // executionApprovedFingerprintHash === the manifest hash and proceed —
    // not re-block. Exercised via checkExecutionGate directly (the same
    // function ExecuteTaskUseCase.enforceExecutionGate calls), since this
    // route file doesn't wire a real ExecuteTaskUseCase.
    const task = makeOpenTask();
    const { opts, getTask } = makeStatefulOpts(task);
    const fingerprint = currentFingerprintFor(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();
    await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    const approvedTask = getTask();
    const gate = checkExecutionGate(approvedTask, { projectId: 10, serverName: 'test-server', workingDirectory: '/work', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' }, fingerprint);
    expect(gate).toEqual({ allowed: true });
  });

  it("logs 'execution_pre_approved' with origin 'creation_form' by default", async () => {
    const task = makeOpenTask();
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprintFor(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint } });

    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', { type: 'execution_pre_approved', origin: 'creation_form' });
  });

  it("accepts origin 'mission_prompt' and logs it on 'execution_pre_approved'", async () => {
    const task = makeOpenTask();
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprintFor(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint, origin: 'mission_prompt' } });

    expect(res.statusCode).toBe(200);
    expect(opts.logRepo.append).toHaveBeenCalledWith(1, 20, 'command', { type: 'execution_pre_approved', origin: 'mission_prompt' });
  });

  it('rejects an unknown origin value with 400', async () => {
    const task = makeOpenTask();
    const { opts } = makeStatefulOpts(task);
    const fingerprint = currentFingerprintFor(opts, task);
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/tasks/1/approve-execution', payload: { approved: true, fingerprint, origin: 'not-a-real-origin' } });

    expect(res.statusCode).toBe(400);
  });
});
