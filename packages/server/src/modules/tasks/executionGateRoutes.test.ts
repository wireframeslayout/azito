import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task } from './Task';
import { ExecutionGateDeniedError } from './execution/ExecutionGate';
import { TaskOriginationService } from './origination/TaskOriginationService';

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
    createdByKind: 'operator',
    createdById: null,
    createdViaGeneration: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(existingTask: Task): { opts: TasksRouteOptions; createCalls: Record<string, unknown>[] } {
  const createCalls: Record<string, unknown>[] = [];
  const taskRepo: TasksRouteOptions['taskRepo'] = {
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
    recordExecutionGateBlock: vi.fn(() => true),
    preApproveExecution: vi.fn(() => true),
    countChildren: vi.fn(() => 0),
    countChildrenInGeneration: vi.fn(() => 0),
    clearTmuxWindowIfMatches: vi.fn(() => true),
  };
  // A real TaskOriginationService wrapping the mock taskRepo above, so this
  // file's "what did taskRepo.create() actually receive" assertions
  // (createCalls) still exercise the real deriveInputTrust() mapping POST
  // /api/tasks now routes through, instead of a hand-mocked pass-through
  // that would silently stop testing that mapping at all.
  const originationService = new TaskOriginationService(taskRepo, { record: vi.fn() } as unknown as TasksRouteOptions['auditLogService']);
  const opts: TasksRouteOptions = {
    taskRepo,
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
    unitTypeLoader: { getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })) } as unknown as TasksRouteOptions['unitTypeLoader'],
    sidekickLoader: { get: vi.fn(() => undefined) } as unknown as TasksRouteOptions['sidekickLoader'],
    projectSecretRepo: { findByProject: vi.fn(() => []) } as unknown as TasksRouteOptions['projectSecretRepo'],
    auditLogService: { record: vi.fn() } as unknown as TasksRouteOptions['auditLogService'],
    originationService,
    taskTokenRepo: { issue: vi.fn(), verify: vi.fn(() => false), revokeAllForTask: vi.fn(() => 0), issueNextGeneration: vi.fn(), getActiveGeneration: vi.fn(() => null) } as unknown as TasksRouteOptions['taskTokenRepo'],
    revokeTaskWindowGeneration: vi.fn(),
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

describe('POST /api/tasks — input_trust derived from source (Issue #328)', () => {
  it("derives inputTrust: 'untrusted' when source is 'github'", async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'Imported issue', source: 'github', source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(200);
    expect(createCalls[0]).toMatchObject({ source: 'github', inputTrust: 'untrusted' });
  });

  it("derives inputTrust: 'untrusted' when source is 'gitlab'", async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'Imported issue', source: 'gitlab', source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(200);
    expect(createCalls[0]).toMatchObject({ source: 'gitlab', inputTrust: 'untrusted' });
  });

  it("keeps inputTrust: 'trusted' when source is omitted (defaults to 'local')", async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'New task' },
    });

    expect(res.statusCode).toBe(200);
    expect(createCalls[0]).toMatchObject({ source: 'local', inputTrust: 'trusted' });
  });

  it("keeps inputTrust: 'trusted' when source is explicitly 'local'", async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'New task', source: 'local' },
    });

    expect(res.statusCode).toBe(200);
    expect(createCalls[0]).toMatchObject({ source: 'local', inputTrust: 'trusted' });
  });

  // Third-party review fix (task/328-input-trust-and-exec-gate follow-up):
  // `source` decides `inputTrust` via a `===` comparison in
  // deriveInputTrust() — an unvalidated wrong-case/whitespace value fell
  // through to 'trusted', silently bypassing the execution gate.
  it('rejects a wrong-case source value ("GitHub") with 400 and does not create the task', async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'Imported issue', source: 'GitHub', source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(400);
    expect(createCalls.length).toBe(0);
  });

  it('rejects a source value with stray whitespace ("github ") with 400', async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'Imported issue', source: 'github ', source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(400);
    expect(createCalls.length).toBe(0);
  });

  it('rejects source_ref supplied without source (would look issue-linked while deriving trusted) with 400', async () => {
    const { opts, createCalls } = makeOpts(makeTask());
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { project_id: 10, title: 'Imported issue', source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(400);
    expect(createCalls.length).toBe(0);
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

  // Regression coverage: require_plan_approval must be validated as an actual
  // boolean before use. Previously `!!value` coerced any non-boolean falsy
  // value (null, 0, '', 'false') to `false` for storage, but the untrusted
  // gate above only ever compared against the *literal* `false` — so a
  // non-boolean falsy value slipped past the `=== false` check and still got
  // coerced to `false` on write, silently disabling plan approval for an
  // untrusted task.
  it.each([null, 0, '', 'false'])(
    'rejects a non-boolean require_plan_approval (%j) on an untrusted task with 400, and does not update',
    async (badValue) => {
      const { opts } = makeOpts(makeTask({ inputTrust: 'untrusted', requirePlanApproval: true }));
      const app = Fastify();
      await app.register(tasksRoutes, opts);
      await app.ready();

      const res = await app.inject({
        method: 'PUT',
        url: '/api/tasks/1',
        payload: { require_plan_approval: badValue },
      });

      expect(res.statusCode).toBe(400);
      expect(opts.taskRepo.update).not.toHaveBeenCalled();
    },
  );

  it.each([null, 0, '', 'false'])(
    'rejects a non-boolean require_plan_approval (%j) on a trusted task with 400 too (type validation applies regardless of trust)',
    async (badValue) => {
      const { opts } = makeOpts(makeTask({ inputTrust: 'trusted', requirePlanApproval: true }));
      const app = Fastify();
      await app.register(tasksRoutes, opts);
      await app.ready();

      const res = await app.inject({
        method: 'PUT',
        url: '/api/tasks/1',
        payload: { require_plan_approval: badValue },
      });

      expect(res.statusCode).toBe(400);
      expect(opts.taskRepo.update).not.toHaveBeenCalled();
    },
  );

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
    // Present-but-undefined (same convention as every other optional PUT
    // field in this handler, e.g. baseBranch/skipPr) — SqliteTaskRepository.
    // update() treats an undefined field as "leave the column unchanged", so
    // an attacker-supplied `input_trust` in the body never reaches the DB.
    expect(updateCall[1].inputTrust).toBeUndefined();
  });
});

describe('PUT /api/tasks/:id — input_trust derivation is monotonic (Issue #328)', () => {
  it("sets inputTrust to 'untrusted' when source is changed to 'github' on a trusted task", async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'trusted', source: 'local' }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { source: 'github', source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(200);
    const updateCall = (opts.taskRepo.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1]).toMatchObject({ inputTrust: 'untrusted' });
  });

  it('never transitions inputTrust back to trusted, even when source is changed back to local', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'untrusted', source: 'github', requirePlanApproval: true }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { source: 'local' },
    });

    expect(res.statusCode).toBe(200);
    const updateCall = (opts.taskRepo.update as ReturnType<typeof vi.fn>).mock.calls[0];
    // Either undefined (leaving the column unchanged — it is already
    // 'untrusted') or explicitly re-asserted as 'untrusted' — never
    // 'trusted'.
    const nextInputTrust = (updateCall[1] as { inputTrust?: string }).inputTrust;
    expect(nextInputTrust === undefined || nextInputTrust === 'untrusted').toBe(true);
  });

  it('does not change inputTrust when source is left untouched on a trusted task', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'trusted', source: 'local', title: 'Old title' }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { title: 'New title' },
    });

    expect(res.statusCode).toBe(200);
    const updateCall = (opts.taskRepo.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[1].inputTrust).toBeUndefined();
  });

  // Same validation as POST /api/tasks above, applied to PUT too (third-party
  // review, task/328 follow-up).
  it('rejects a wrong-case source value ("GitHub") with 400 and does not update the task', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'trusted', source: 'local' }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { source: 'GitHub', source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(400);
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });

  it('rejects source_ref supplied without source with 400', async () => {
    const { opts } = makeOpts(makeTask({ inputTrust: 'trusted', source: 'local' }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { source_ref: 'org/repo#1' },
    });

    expect(res.statusCode).toBe(400);
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });
});

describe('PUT /api/tasks/:id — status is locked while pending_approval (Issue #328)', () => {
  // Regression: PUT used to accept an arbitrary `status` unconditionally
  // (`status: (status as TaskStatus) || existing.status`), even for a task
  // whose status is `pending_approval`. Moving it away from
  // `pending_approval` this way leaves `pendingOperation` (and
  // `pendingOperationWindowId`/`pendingOperationPriorStatus`) set: the
  // approval screen (GET .../execution-approval) then 404/400s because
  // status is no longer `pending_approval`, and checkExecutionGate refuses
  // to record a new block because pendingOperation is already non-null — a
  // task the approval UI and the execution gate can no longer touch.
  it('rejects a status change on a pending_approval task with 409, and does not update', async () => {
    const { opts } = makeOpts(makeTask({
      status: 'pending_approval',
      pendingOperation: 'execute',
      pendingOperationPriorStatus: 'open',
    }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { status: 'open' },
    });

    expect(res.statusCode).toBe(409);
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });

  it('rejects even a same-value status round-trip on a pending_approval task (a stale edit-form save resubmits the old status verbatim)', async () => {
    const { opts } = makeOpts(makeTask({
      status: 'pending_approval',
      pendingOperation: 'restore',
      pendingOperationPriorStatus: 'archived',
    }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { status: 'pending_approval', title: 'Edited title' },
    });

    expect(res.statusCode).toBe(409);
    expect(opts.taskRepo.update).not.toHaveBeenCalled();
  });

  it('allows editing other fields on a pending_approval task as long as `status` itself is omitted from the body', async () => {
    const { opts } = makeOpts(makeTask({
      status: 'pending_approval',
      pendingOperation: 'execute',
      pendingOperationPriorStatus: 'open',
    }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { title: 'Edited title' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.update).toHaveBeenCalled();
  });

  it('allows a status change on a non-pending_approval task (unaffected — legacy behavior preserved)', async () => {
    const { opts } = makeOpts(makeTask({ status: 'open' }));
    const app = Fastify();
    await app.register(tasksRoutes, opts);
    await app.ready();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/1',
      payload: { status: 'archived' },
    });

    expect(res.statusCode).toBe(200);
    expect(opts.taskRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'archived' }));
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
