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
    createdByKind: 'operator',
    createdById: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Builds a Fastify app with the SAME onRequest auth pipeline app/buildServer.ts installs, in front of tasksRoutes only. */
function buildApp(scopedAuthEnabled: boolean, db: SqliteDatabase, createCalls: Record<string, unknown>[]): { app: FastifyInstance; taskTokenRepo: SqliteTaskTokenRepository } {
  const taskTokenRepo = new SqliteTaskTokenRepository(db);
  const verifyUiToken = createTokenVerifier(UI_TOKEN);
  const auditLogService = new AuditLogService({ record: vi.fn() });

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
    serverRepo: { findAll: vi.fn(() => []), findByName: vi.fn(() => null), create: vi.fn(), update: vi.fn(), updateAgentVersion: vi.fn(), updateFingerprint: vi.fn(), clearFingerprint: vi.fn(), delete: vi.fn() },
    worktreeServiceFactory: {} as unknown as TasksRouteOptions['worktreeServiceFactory'],
    transportFactory: {} as unknown as TasksRouteOptions['transportFactory'],
    windowRepo: { findByTaskIds: vi.fn(() => new Map()), add: vi.fn(), findAll: vi.fn(() => []), findById: vi.fn(), findByProject: vi.fn(() => []), findByTask: vi.fn(() => []), findAgentSessionIdsByServer: vi.fn(() => new Set<string>()), findByServerAndTarget: vi.fn(), update: vi.fn(), updateAgentSessionIdByWindow: vi.fn(), remove: vi.fn(), removeByServerAndTarget: vi.fn(() => 0), updatePaneLayout: vi.fn() },
    respawnService: {} as unknown as TasksRouteOptions['respawnService'],
    taskRestoreService: {} as unknown as TasksRouteOptions['taskRestoreService'],
    unitTypeLoader: {} as unknown as TasksRouteOptions['unitTypeLoader'],
    sidekickLoader: {} as unknown as TasksRouteOptions['sidekickLoader'],
    projectSecretRepo: { findByProject: vi.fn(() => []) } as unknown as TasksRouteOptions['projectSecretRepo'],
    auditLogService,
    originationService,
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

  return { app, taskTokenRepo };
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
      });
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
