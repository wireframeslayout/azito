import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task, ITaskRepository } from './Task';
import { openDatabase, type SqliteDatabase } from '../../shared/db/Database';
import { SqliteTaskTokenRepository } from './tokens/SqliteTaskTokenRepository';
import { TaskOriginationService } from './origination/TaskOriginationService';
import { AuditLogService } from '../../shared/audit/AuditLogService';
import { resolvePrincipal } from '../../shared/auth/resolvePrincipal';
import { evaluateRouteAuth } from '../../shared/auth/routeAuth';
import { createTokenVerifier } from '../servers/auth/tokenAuth';

// Integration coverage for Issue #28 design v3 §4's task-principal surface:
// POST /api/tasks/:id/children (task-self-only, untrusted-fixed) and POST
// /api/tasks (operator-only by omission). Unlike this module's other route
// test files, THIS file wires the real onRequest auth pipeline
// (resolvePrincipal + evaluateRouteAuth, mirroring app/buildServer.ts's
// hook) in front of tasksRoutes, because these two behaviors only exist at
// that boundary — a route-body-only test (as the other files in this
// directory use) would never actually exercise principal resolution or the
// AZITO_SCOPED_AUTH gate.

const UI_TOKEN = 'operator-ui-token';

function makeTask(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 10,
    unitId: null,
    serverName: null,
    title: 'Parent task',
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
  sleepAfterPush: null,
    createdByKind: 'operator',
    createdById: null,
    createdViaGeneration: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Builds a Fastify app with the SAME onRequest auth pipeline app/buildServer.ts installs, in front of tasksRoutes only. */
function buildApp(scopedAuthEnabled: boolean, db: SqliteDatabase, createCalls: Record<string, unknown>[], auditRecordImpl: (...args: unknown[]) => unknown = vi.fn()): { app: FastifyInstance; taskTokenRepo: SqliteTaskTokenRepository; taskRepo: TasksRouteOptions['taskRepo'] } {
  const taskTokenRepo = new SqliteTaskTokenRepository(db);
  const verifyUiToken = createTokenVerifier(UI_TOKEN);
  const auditLogService = new AuditLogService({ record: auditRecordImpl, listRecent: vi.fn(() => []) });

  const tasks = new Map<number, Task>([
    [1, makeTask(1)],
    [2, makeTask(2)],
  ]);
  const taskRepo: TasksRouteOptions['taskRepo'] = {
    findAll: vi.fn(() => [...tasks.values()]),
    findByProject: vi.fn(() => []),
    findByUnit: vi.fn(() => []),
    findByStatus: vi.fn(() => []),
    findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
    findById: vi.fn((id: number) => tasks.get(id) ?? null),
    create: vi.fn((data: Record<string, unknown>) => { createCalls.push(data); return 100 + createCalls.length; }),
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
  const originationService = new TaskOriginationService(taskRepo as unknown as ITaskRepository, auditLogService);

  const opts: TasksRouteOptions = {
    taskRepo,
    projectRepo: { findAll: vi.fn(() => []), findById: vi.fn(() => ({ id: 10, name: 'P', slug: 'p' })), create: vi.fn(), update: vi.fn(), delete: vi.fn(), addRepository: vi.fn(), findRepositoryById: vi.fn(() => null), removeRepository: vi.fn() } as unknown as TasksRouteOptions['projectRepo'],
    projectServerRepo: { findByProject: vi.fn(() => []), findByServer: vi.fn(() => []), find: vi.fn(() => null), upsert: vi.fn(), remove: vi.fn() },
    logRepo: { findByTask: vi.fn(() => []), findByUnit: vi.fn(() => []), append: vi.fn() },
    executeTaskUseCase: { stopByTaskId: vi.fn(() => false), execute: vi.fn(), followUp: vi.fn(), events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } } as unknown as TasksRouteOptions['executeTaskUseCase'],
    unitRepo: { findAll: vi.fn(() => []), findById: vi.fn(() => null), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    tmux: {} as unknown as TasksRouteOptions['tmux'],
    serverRepo: { findAll: vi.fn(() => []), findByName: vi.fn(() => null), create: vi.fn(), update: vi.fn(), updateAgentVersion: vi.fn(), updateFingerprint: vi.fn(), clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(), delete: vi.fn() },
    worktreeServiceFactory: {} as unknown as TasksRouteOptions['worktreeServiceFactory'],
    transportFactory: {} as unknown as TasksRouteOptions['transportFactory'],
    windowRepo: { findByTaskIds: vi.fn(() => new Map()), add: vi.fn(), findAll: vi.fn(() => []), findById: vi.fn(), findByProject: vi.fn(() => []), findByTask: vi.fn(() => []), findAgentSessionIdsByServer: vi.fn(() => new Set<string>()), findByServer: vi.fn(() => []), findByServerAndTarget: vi.fn(), findByServerAndSession: vi.fn(() => []), update: vi.fn(), updateAgentSessionIdByWindow: vi.fn(), remove: vi.fn(), removeByServerAndTarget: vi.fn(() => 0), updatePaneLayout: vi.fn(), now: vi.fn(() => '2026-01-01 00:00:00') },
    respawnService: {} as unknown as TasksRouteOptions['respawnService'],
    taskRestoreService: {} as unknown as TasksRouteOptions['taskRestoreService'],
    unitTypeLoader: {} as unknown as TasksRouteOptions['unitTypeLoader'],
    sidekickLoader: {} as unknown as TasksRouteOptions['sidekickLoader'],
    projectSecretRepo: { findByProject: vi.fn(() => []) } as unknown as TasksRouteOptions['projectSecretRepo'],
    auditLogService,
    originationService,
    taskTokenRepo,
    destroyPrimaryTaskWindow: vi.fn(async (_taskId, _windowName, _serverName, _target, _reason, kill, onDestroyed) => {
      const result = await kill();
      onDestroyed();
      return { success: result.code === 0, alreadyGone: false, result };
    }),
    scopedAuthEnabled: true,
  };

  const app = Fastify();
  // Mirrors app/buildServer.ts's onRequest hook exactly (principal
  // resolution + evaluateRouteAuth + AZITO_SCOPED_AUTH gating), scoped down
  // to just this test's Fastify instance.
  app.addHook('onRequest', async (request, reply) => {
    const principal = resolvePrincipal(request.headers.authorization, { verifyUiToken, taskTokenRepo });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;
    const { allowed, operation } = evaluateRouteAuth(principal, request);
    if (!allowed) {
      auditLogService.record({ actorClass: principal.class, actorId: principal.id ?? null, event: scopedAuthEnabled ? 'route_auth.denied' : 'route_auth.would_deny', detail: { operation } });
      if (scopedAuthEnabled) return reply.status(403).send({ error: 'operator_required', operation });
    }
  });
  app.register(tasksRoutes, opts);

  return { app, taskTokenRepo, taskRepo };
}

describe('POST /api/tasks/:id/children + POST /api/tasks — task-principal surface (Issue #28 design v3 §4)', () => {
  let db: SqliteDatabase;
  let createCalls: Record<string, unknown>[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    createCalls = [];
  });

  afterEach(() => {
    db.close();
  });

  describe('AZITO_SCOPED_AUTH=1 (flag on)', () => {
    it("a task's own token can create a child, always inputTrust='untrusted' and created_by_kind='task'", async () => {
      const { app, taskTokenRepo } = buildApp(true, db, createCalls);
      await app.ready();
      const { token } = taskTokenRepo.issue(1, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Child task' },
      });

      expect(res.statusCode).toBe(201);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toMatchObject({
        projectId: 10, // fixed to the PARENT's project, not caller-supplied
        inputTrust: 'untrusted',
        createdByKind: 'task',
        createdById: 1,
        source: 'local',
        // Issue #28 third-party review fix: stamped with the calling
        // token's active generation (taskTokenRepo.issue(1, 1) above minted
        // window_generation 1), not left null the way an operator-created
        // child would be.
        createdViaGeneration: 1,
      });
    });

    // Issue #28 third-party review finding: the per-parent children cap was
    // a lifetime count, so a parent that crossed N=20 across several
    // follow-up runs could never spawn another child again in ANY future
    // run. Fixed by scoping the count to the parent's CURRENT active window
    // generation — this test verifies the reset actually happens across a
    // generation rotation (issueNextGeneration, as a real
    // execute()/follow-up/respawn would perform).
    it('resets the per-run child count when the parent token generation rotates, but keeps counting within the SAME generation', async () => {
      const { app, taskTokenRepo, taskRepo } = buildApp(true, db, createCalls);
      await app.ready();

      // Generation 1: already at the per-run cap.
      const gen1 = taskTokenRepo.issue(1, 1);
      (taskRepo.countChildrenInGeneration as ReturnType<typeof vi.fn>).mockImplementation(
        (_parentId: number, generation: number) => (generation === 1 ? 20 : 0),
      );

      const blockedRes = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${gen1.token}` },
        payload: { title: 'One too many for generation 1' },
      });
      expect(blockedRes.statusCode).toBe(429);
      expect(createCalls).toHaveLength(0);

      // Generation 2: a fresh rotation (what a real execute()/follow-up/
      // respawn does via TaskPaneEnvironmentService.buildEnvForNewWindow) —
      // the mocked countChildrenInGeneration above returns 0 for any
      // generation other than 1, so this must succeed.
      const gen2 = taskTokenRepo.issueNextGeneration(1, 'window_regenerated');
      const allowedRes = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${gen2.token}` },
        payload: { title: 'First child of generation 2' },
      });
      expect(allowedRes.statusCode).toBe(201);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0]).toMatchObject({ createdViaGeneration: 2 });
    });

    // Issue #28 third-party review fix: an operator call has no window
    // generation, so it falls back to the looser, ungenerationed lifetime
    // cap (MAX_CHILDREN_PER_PARENT_OPERATOR = 100) rather than either the
    // task-principal per-run cap or no cap at all.
    it("caps an operator's children at the looser lifetime limit, not the per-generation N=20", async () => {
      const { app, taskRepo } = buildApp(true, db, createCalls);
      await app.ready();
      (taskRepo.countChildren as ReturnType<typeof vi.fn>).mockReturnValue(100);

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${UI_TOKEN}` },
        payload: { title: 'Over the operator lifetime cap' },
      });

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: 'Task 1 already has 100 children (limit 100)' });
      expect(createCalls).toHaveLength(0);
    });

    // Issue #28 third-party review finding (Minor): the limit-exceeded audit
    // write must be best-effort, same as every other audit call site — a
    // throwing record() must not turn the already-computed 429 into a
    // generic 500.
    it('still returns 429 when the limit-exceeded audit write throws', async () => {
      const throwingRecord = vi.fn(() => { throw new Error('audit db is locked'); });
      const { app, taskRepo } = buildApp(true, db, createCalls, throwingRecord);
      await app.ready();
      (taskRepo.countChildren as ReturnType<typeof vi.fn>).mockReturnValue(100);

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${UI_TOKEN}` },
        payload: { title: 'Over the operator lifetime cap, audit write fails' },
      });

      expect(throwingRecord).toHaveBeenCalled();
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: 'Task 1 already has 100 children (limit 100)' });
      expect(createCalls).toHaveLength(0);
    });

    // Issue #28 third-party review finding 4: `description` was cast to
    // `string` with no runtime check, so an object body value reached the
    // SQLite bind unvalidated and 500'd instead of 400ing.
    it('rejects a non-string, non-null description with 400 (never reaches taskRepo.create)', async () => {
      const { app, taskTokenRepo } = buildApp(true, db, createCalls);
      await app.ready();
      const { token } = taskTokenRepo.issue(1, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Child task', description: { nested: 'object' } },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'description must be a string or null' });
      expect(createCalls).toHaveLength(0);
    });

    it('accepts a null description and a string description', async () => {
      const { app, taskTokenRepo } = buildApp(true, db, createCalls);
      await app.ready();
      const { token } = taskTokenRepo.issue(1, 1);

      const resNull = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Child task', description: null },
      });
      const resString = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Child task 2', description: 'a plain description' },
      });

      expect(resNull.statusCode).toBe(201);
      expect(resString.statusCode).toBe(201);
      expect(createCalls).toHaveLength(2);
      expect(createCalls[0]).toMatchObject({ description: null });
      expect(createCalls[1]).toMatchObject({ description: 'a plain description' });
    });

    it("a task's token is rejected (403) when addressing a DIFFERENT task's children endpoint", async () => {
      const { app, taskTokenRepo } = buildApp(true, db, createCalls);
      await app.ready();
      const { token } = taskTokenRepo.issue(1, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/2/children',
        headers: { authorization: `Bearer ${token}` },
        payload: { title: 'Child task' },
      });

      expect(res.statusCode).toBe(403);
      expect(createCalls).toHaveLength(0);
    });

    it('an operator UI token may also create a child (fixed to the parent task as origin, not "operator")', async () => {
      const { app } = buildApp(true, db, createCalls);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks/1/children',
        headers: { authorization: `Bearer ${UI_TOKEN}` },
        payload: { title: 'Child task' },
      });

      expect(res.statusCode).toBe(201);
      expect(createCalls[0]).toMatchObject({ createdByKind: 'task', createdById: 1, inputTrust: 'untrusted' });
    });

    it("a task's token is rejected (403) on plain POST /api/tasks (operator-only by omission)", async () => {
      const { app, taskTokenRepo } = buildApp(true, db, createCalls);
      await app.ready();
      const { token } = taskTokenRepo.issue(1, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: `Bearer ${token}` },
        payload: { project_id: 10, title: 'Sneaky top-level task' },
      });

      expect(res.statusCode).toBe(403);
      expect(createCalls).toHaveLength(0);
    });

    it('an operator UI token creates a plain top-level task as trusted (createdByKind: operator)', async () => {
      const { app } = buildApp(true, db, createCalls);
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: `Bearer ${UI_TOKEN}` },
        payload: { project_id: 10, title: 'Operator task' },
      });

      expect(res.statusCode).toBe(200);
      expect(createCalls[0]).toMatchObject({ inputTrust: 'trusted', createdByKind: 'operator', createdById: null });
    });
  });

  describe('AZITO_SCOPED_AUTH off (compat mode — audits, does not block)', () => {
    it("a task's token is NOT blocked on plain POST /api/tasks, but is honestly recorded as created_by_kind='task' (and therefore still untrusted)", async () => {
      const { app, taskTokenRepo } = buildApp(false, db, createCalls);
      await app.ready();
      const { token } = taskTokenRepo.issue(1, 1);

      const res = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { authorization: `Bearer ${token}` },
        payload: { project_id: 10, title: 'Compat-mode task from a task token' },
      });

      expect(res.statusCode).toBe(200);
      expect(createCalls[0]).toMatchObject({ createdByKind: 'task', createdById: 1, inputTrust: 'untrusted' });
    });
  });
});
