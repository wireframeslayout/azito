import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { resolvePrincipal } from '../shared/auth/resolvePrincipal';
import { evaluateRouteAuth } from '../shared/auth/routeAuth';
import { formatTaskToken } from '../shared/auth/taskTokenFormat';
import type { RouteAuthRequirement } from '../shared/auth/routeAuth';
import sidekicksRoutes from '../modules/sidekicks/routes';
import { SidekickPackageLoader, DEFAULT_USER_SIDEKICKS_DIR } from '../modules/sidekicks/SidekickPackageLoader';
import { SidekickPackageService } from '../modules/sidekicks/SidekickPackageService';
import { UnitTypeLoader } from '../modules/sidekicks/UnitTypeLoader';
import { resolvePhaseSidekick } from '../modules/sidekicks/resolvePhaseSidekick';
import { resolveUnitId } from '../modules/tasks/execution/TaskExecutionEnv';
import type { ITaskPromptVarsResolver, TaskPromptVars } from '../modules/sidekicks/ITaskPromptVarsResolver';

/**
 * Issue #28 third-party review fix 1+2: the azt-sidekick pane flow was
 * severed under AZITO_SCOPED_AUTH=1 —
 * - GET /api/sidekicks (bare `/azt-sidekick`) had NO task-principal auth
 *   declaration at all, so a task token always 403'd.
 * - GET /api/sidekicks/:name?render=1 without an explicit task_id 403'd on
 *   sidekickDetailAuth's `task_id=self` requirement, even though
 *   AZITO_TASK_ID is already injected into every task pane.
 *
 * This suite exercises the REAL sidekicksRoutes plugin plus an onRequest
 * hook shaped exactly like buildServer.ts's (same resolvePrincipal +
 * evaluateRouteAuth call), with the SAME task-principal auth requirements
 * buildServer.ts builds (reproduced here at the wiring level only — the
 * underlying assigned-Sidekick resolution logic itself is not duplicated:
 * this test calls the same `resolvePhaseSidekick` production helper the
 * real buildServer.ts uses to build its resolver).
 */

const UI_TOKEN = 'a'.repeat(64);
const TASK_ID = 7;
const TASK_SECRET = 'b'.repeat(64);
const TASK_TOKEN = formatTaskToken(TASK_ID, TASK_SECRET);

const FAKE_VARS: TaskPromptVars = {
  task: { title: 'T', description: '', plan: '', targetBranch: '', pushTaskDescription: '', pushRules: '', pushOutput: '' },
  project: { sidekickPrompt: '', defaultBranch: 'main' },
  projectServer: { workingDirectory: '.', branch: '' },
  selfReview: { attempt: '1', maxAttempts: '2' },
  module: { reviewPerspectives: '', softwareDesignPrinciples: '', uiDesignPrinciples: '' },
};

interface FakeTask {
  id: number;
  projectId: number;
  unitId: number | null;
}

interface FakeUnit {
  id: number;
  unitType: string;
  phaseConfig: null;
}

function buildApp(scopedAuthEnabled = true): {
  app: FastifyInstance;
  taskRepo: { findById: (id: number) => FakeTask | undefined };
  unitRepo: { findById: (id: number) => FakeUnit | undefined };
} {
  const verifyUiToken = createTokenVerifier(UI_TOKEN);
  const taskTokenRepo = { verify: vi.fn((taskId: number, secret: string) => taskId === TASK_ID && secret === TASK_SECRET) };

  const task: FakeTask = { id: TASK_ID, projectId: 1, unitId: 1 };
  const unit: FakeUnit = { id: 1, unitType: 'devops', phaseConfig: null };
  const taskRepo = { findById: (id: number) => (id === task.id ? task : undefined) };
  const projectRepo = { findById: (_id: number) => ({ defaultUnitId: null }) };
  const unitRepo = { findById: (id: number) => (id === unit.id ? unit : undefined) };

  const unitTypeLoader = new UnitTypeLoader();
  const sidekickPackageLoader = new SidekickPackageLoader();
  const sidekickService = new SidekickPackageService(sidekickPackageLoader, DEFAULT_USER_SIDEKICKS_DIR);

  // Same resolver buildServer.ts builds (production `resolvePhaseSidekick`
  // helper underneath — only the cross-module task->unit walk is
  // reproduced here, per the mid-layer dependency-cruiser rule).
  function resolveAssignedSidekickNamesForTask(taskId: number): Set<string> {
    const t = taskRepo.findById(taskId);
    if (!t) return new Set();
    const project = projectRepo.findById(t.projectId);
    const resolvedUnitId = resolveUnitId(t, project);
    if (resolvedUnitId === null) return new Set();
    const u = unitRepo.findById(resolvedUnitId);
    if (!u) return new Set();
    const unitType = unitTypeLoader.getOrThrow(u.unitType);
    const names = new Set<string>();
    for (const phaseDef of unitType.phases) {
      try {
        const pkg = resolvePhaseSidekick(sidekickPackageLoader, phaseDef.name, u.phaseConfig, phaseDef);
        names.add(pkg.name);
      } catch {
        // not a grant
      }
    }
    return names;
  }

  const detailAuth: RouteAuthRequirement = {
    classes: ['task'],
    operation: 'sidekicks.render',
    condition: (principal, request) => {
      const query = request.query as { render?: string; task_id?: string };
      if (query.render !== '1' || !query.task_id) return false;
      const taskId = Number(query.task_id);
      if (!Number.isInteger(taskId) || principal.id !== taskId) return false;
      const name = (request.params as { name: string }).name;
      return resolveAssignedSidekickNamesForTask(taskId).has(name);
    },
  };

  const listAuth: RouteAuthRequirement = { classes: ['task'], operation: 'sidekicks.list' };

  const app = Fastify();

  // Mirrors buildServer.ts's real onRequest hook exactly (Phase C round-4
  // review, Important finding): the 403 is only actually enforced when
  // `scopedAuthEnabled` is true — while it's false (compat mode), a denied
  // evaluation is logged but the request still passes through. Earlier
  // versions of this test's hook always enforced (hardcoded to what is now
  // `scopedAuthEnabled = true`), so it could never have caught the sibling
  // bug this fix addresses: the sidekicksRoutes list handler applying its
  // own task-principal filter unconditionally, even in compat mode.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;
    const principal = resolvePrincipal(request.headers.authorization, { verifyUiToken, taskTokenRepo });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;
    const { allowed, operation } = evaluateRouteAuth(principal, request);
    if (!allowed && scopedAuthEnabled) {
      return reply.status(403).send({ error: 'operator_required', operation });
    }
  });

  const taskPromptVarsResolver: ITaskPromptVarsResolver = {
    resolve: () => FAKE_VARS,
    resolveDir: async (_taskId, pkg) => pkg.dir,
  };

  app.register(sidekicksRoutes, {
    sidekickService,
    taskPromptVarsResolver,
    unitTypeLoader,
    detailAuth,
    listAuth,
    resolveAssignedSidekickNames: resolveAssignedSidekickNamesForTask,
    scopedAuthEnabled,
  });

  return { app, taskRepo, unitRepo };
}

describe('sidekicks task-pane auth wiring (Issue #28 third-party review fix 1+2)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('GET /api/sidekicks with only a task token succeeds and returns ONLY the assigned Sidekicks (bare `/azt-sidekick`)', async () => {
    ({ app } = buildApp());
    const res = await app.inject({ method: 'GET', url: '/api/sidekicks', headers: { authorization: `Bearer ${TASK_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const names: string[] = res.json().map((p: { name: string }) => p.name);
    expect(names).toContain('planning-default');
    expect(names).toContain('pushing-default');
    // Every entry returned must actually be assigned to this task's Unit —
    // never the full unfiltered catalog.
    for (const name of names) {
      expect(['planning-default', 'implementing-default', 'reviewing-default', 'testing-default', 'pushing-default']).toContain(name);
    }
  });

  it('an operator UI token still sees the full unfiltered list', async () => {
    ({ app } = buildApp());
    const res = await app.inject({ method: 'GET', url: '/api/sidekicks', headers: { authorization: `Bearer ${UI_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const names: string[] = res.json().map((p: { name: string }) => p.name);
    // issue-default carries no phase tag, so it's never assigned to any
    // task's Unit — only an operator's unfiltered list includes it.
    expect(names).toContain('issue-default');
  });

  it('GET /api/sidekicks/:name?render=1 with only AZITO_TASK_ID (no explicit task_id query) succeeds for an assigned Sidekick', async () => {
    ({ app } = buildApp());
    // Mirrors azt-sidekick's Step 3a curl once TASK_ID defaults from
    // $AZITO_TASK_ID: task_id is always supplied by the skill, sourced from
    // the pane's own AZITO_TASK_ID env var rather than a positional arg.
    const res = await app.inject({
      method: 'GET',
      url: `/api/sidekicks/planning-default?render=1&task_id=${TASK_ID}`,
      headers: { authorization: `Bearer ${TASK_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toBeTypeOf('string');
  });

  it('GET /api/sidekicks/:name?render=1 for a Sidekick NOT assigned to the task Unit is still 403', async () => {
    ({ app } = buildApp());
    const res = await app.inject({
      method: 'GET',
      url: `/api/sidekicks/issue-default?render=1&task_id=${TASK_ID}`,
      headers: { authorization: `Bearer ${TASK_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /api/sidekicks/:name?render=1 for a DIFFERENT task_id than the token owner is still 403', async () => {
    ({ app } = buildApp());
    const res = await app.inject({
      method: 'GET',
      url: `/api/sidekicks/planning-default?render=1&task_id=${TASK_ID + 1}`,
      headers: { authorization: `Bearer ${TASK_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

// Phase C round-4 review, Important finding: GET /api/sidekicks used to
// apply the task-principal narrowing filter unconditionally, regardless of
// AZITO_SCOPED_AUTH — a task pane always carries a task token (azt-sidekick
// prefers it over any operator credential it might also have), so a
// compat-mode deployment (flag off, the default) still saw its list
// silently narrowed to the task's assigned Sidekicks, breaking this PR's
// core "flag off => behavior unchanged" guarantee. Detail requests were
// never rejected in compat mode either (the onRequest hook only enforces
// when the flag is on), so list and detail visibly disagreed with each
// other on top of disagreeing with the flag's own contract.
describe('sidekicks list filtering respects AZITO_SCOPED_AUTH (Phase C round-4 review)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('compat mode (flag off): a task token still sees the FULL unfiltered list, same as an operator', async () => {
    ({ app } = buildApp(false));
    const res = await app.inject({ method: 'GET', url: '/api/sidekicks', headers: { authorization: `Bearer ${TASK_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const names: string[] = res.json().map((p: { name: string }) => p.name);
    // issue-default carries no phase tag and is never assigned to any
    // task's Unit — only an unfiltered list includes it. Compat mode must
    // return it to a task principal too, exactly like it does for an
    // operator UI token.
    expect(names).toContain('issue-default');
  });

  it('compat mode (flag off): a request evaluateRouteAuth would deny is still let through (list unaffected)', async () => {
    ({ app } = buildApp(false));
    const res = await app.inject({
      method: 'GET',
      url: `/api/sidekicks/issue-default?render=1&task_id=${TASK_ID}`,
      headers: { authorization: `Bearer ${TASK_TOKEN}` },
    });
    // In enforce mode this exact request 403s (see the detail-route test
    // above) — in compat mode it must pass through unchanged.
    expect(res.statusCode).toBe(200);
  });

  it('scoped mode (flag on): a task token sees ONLY the assigned Sidekicks — behavior unchanged from before this fix', async () => {
    ({ app } = buildApp(true));
    const res = await app.inject({ method: 'GET', url: '/api/sidekicks', headers: { authorization: `Bearer ${TASK_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const names: string[] = res.json().map((p: { name: string }) => p.name);
    expect(names).not.toContain('issue-default');
  });
});
