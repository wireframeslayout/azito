import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { resolvePrincipal } from '../shared/auth/resolvePrincipal';
import { evaluateRouteAuth, UNMATCHED_ROUTE } from '../shared/auth/routeAuth';
import type { RouteAuthRequirement } from '../shared/auth/routeAuth';

// Exercises the SAME building blocks buildServer.ts wires into its onRequest
// hook (resolvePrincipal + evaluateRouteAuth), against a minimal app, so this
// stays in sync with the real hook's logic without needing the full Wiring
// object buildServer.ts requires. See buildServer.auth.test.ts for the
// pre-existing UI-token-only hook coverage this extends (Issue #28 Phase A).

const UI_TOKEN = 'a'.repeat(64);
const TASK_SECRET = 'b'.repeat(64);
const TASK_ID = 7;

function buildApp(opts: { scopedAuthEnabled: boolean; verifyResult?: boolean }): {
  app: FastifyInstance;
  auditRecord: ReturnType<typeof vi.fn>;
} {
  const verifyUiToken = createTokenVerifier(UI_TOKEN);
  const taskTokenRepo = { verify: vi.fn((_taskId: number, secret: string) => (opts.verifyResult ?? secret === TASK_SECRET)) };
  const auditRecord = vi.fn();

  const app = Fastify();

  const selfTaskAuth: RouteAuthRequirement = {
    classes: ['task'],
    operation: 'tasks.detail',
    condition: (principal, request) => Number((request.params as { id: string }).id) === principal.id,
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api')) return;

    const principal = resolvePrincipal(request.headers.authorization, { verifyUiToken, taskTokenRepo });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;

    const { allowed, operation } = evaluateRouteAuth(principal, request);
    if (!allowed) {
      auditRecord({
        actorClass: principal.class,
        actorId: principal.id ?? null,
        event: opts.scopedAuthEnabled ? 'route_auth.denied' : 'route_auth.would_deny',
        // Same shape as buildServer.ts's real hook (Issue #28 third-party
        // review finding 2, a later round): url falls back to the fixed
        // UNMATCHED_ROUTE placeholder, never request.url, so an unmatched
        // route's raw (caller-controlled, query-string-bearing) URL never
        // reaches audit_log.
        detail: { operation, method: request.method, url: request.routeOptions.url ?? UNMATCHED_ROUTE },
      });
      if (opts.scopedAuthEnabled) {
        return reply.status(403).send({ error: 'operator_required', operation });
      }
    }
  });

  app.get('/api/operator-only', async () => ({ ok: true }));
  app.get<{ Params: { id: string } }>('/api/tasks/:id', { config: { auth: selfTaskAuth } }, async () => ({ ok: true }));

  return { app, auditRecord };
}

describe('buildServer route auth (Issue #28 Phase A)', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  describe('AZITO_SCOPED_AUTH off (default/compat mode)', () => {
    it('allows a task token through an operator-only route (no 403)', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: false }));
      const res = await app.inject({
        method: 'GET',
        url: '/api/operator-only',
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('still audit-logs the would-be denial', async () => {
      const built = buildApp({ scopedAuthEnabled: false });
      app = built.app;
      await app.inject({
        method: 'GET',
        url: '/api/operator-only',
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });
      expect(built.auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ actorClass: 'task', actorId: TASK_ID, event: 'route_auth.would_deny' }),
      );
    });

    it('allows a task token on its own task-self route', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: false }));
      const res = await app.inject({
        method: 'GET',
        url: `/api/tasks/${TASK_ID}`,
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('still allows an operator UI token everywhere', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: false }));
      const res = await app.inject({ method: 'GET', url: '/api/operator-only', headers: { authorization: `Bearer ${UI_TOKEN}` } });
      expect(res.statusCode).toBe(200);
    });

    it('401s an invalid task token instead of falling back to UI-token check', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: false, verifyResult: false }));
      const res = await app.inject({
        method: 'GET',
        url: '/api/operator-only',
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${'0'.repeat(64)}` },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('AZITO_SCOPED_AUTH on', () => {
    it('403s a task token on an operator-only route with { error: "operator_required" }', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: true }));
      const res = await app.inject({
        method: 'GET',
        url: '/api/operator-only',
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'operator_required', operation: 'GET /api/operator-only' });
    });

    it('allows a task token on its own task-self route', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: true }));
      const res = await app.inject({
        method: 'GET',
        url: `/api/tasks/${TASK_ID}`,
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it('403s a task token calling a DIFFERENT task id (condition violation)', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: true }));
      const res = await app.inject({
        method: 'GET',
        url: `/api/tasks/${TASK_ID + 1}`,
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'operator_required', operation: 'tasks.detail' });
    });

    it('allows an operator UI token on every route, including the self-task one for a different id', async () => {
      ({ app } = buildApp({ scopedAuthEnabled: true }));
      const res = await app.inject({ method: 'GET', url: `/api/tasks/${TASK_ID + 1}`, headers: { authorization: `Bearer ${UI_TOKEN}` } });
      expect(res.statusCode).toBe(200);
    });
  });

  // Issue #28 third-party review finding 2 (a later round): an unmatched
  // route has no `routeOptions.url` (routing never resolved a route), so the
  // fallback used to be the raw `request.url` — including its query string.
  // That leaked caller-supplied values into audit_log AND let a caller defeat
  // AuditLogService's flood dedup (which keys on the full JSON `detail`)
  // simply by varying the query string on every probe of the same unmatched
  // path. Both `operation` (routeAuth.ts) and the audit `detail.url`
  // (buildServer.ts) must use the fixed UNMATCHED_ROUTE placeholder instead.
  describe('unmatched route (no route ever matched)', () => {
    it('audit-logs a fixed placeholder, never the raw query-string-bearing URL, regardless of query string', async () => {
      const built = buildApp({ scopedAuthEnabled: true });
      app = built.app;

      const resA = await app.inject({
        method: 'GET',
        url: '/api/does-not-exist?q=secret-token-value',
        headers: { authorization: `Bearer ${UI_TOKEN}` },
      });
      const resB = await app.inject({
        method: 'GET',
        url: '/api/does-not-exist?q=a-completely-different-value',
        headers: { authorization: `Bearer ${UI_TOKEN}` },
      });

      // An operator token reaching a genuinely unmatched route still 404s
      // (Fastify's own not-found handling), not 403 — this test only cares
      // about what the hook would have recorded had it denied, so it uses
      // the task token path below for a real denial. Kept for documentation:
      // an operator never triggers evaluateRouteAuth's unmatched branch
      // because operators are allowed everywhere before any 404 check.
      expect(resA.statusCode).toBe(404);
      expect(resB.statusCode).toBe(404);

      // A task token, which IS denied (operator-only by default), exercises
      // the actual audit path for an unmatched route.
      built.auditRecord.mockClear();
      const resTaskA = await app.inject({
        method: 'GET',
        url: '/api/does-not-exist?q=secret-token-value',
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });
      const resTaskB = await app.inject({
        method: 'GET',
        url: '/api/does-not-exist?q=a-completely-different-value',
        headers: { authorization: `Bearer azt.task.${TASK_ID}.${TASK_SECRET}` },
      });

      // The task token is denied by evaluateRouteAuth itself (unmatched ->
      // no `requirement` -> default-deny), so the hook replies 403 before
      // Fastify's own 404 handling ever runs.
      expect(resTaskA.statusCode).toBe(403);
      expect(resTaskB.statusCode).toBe(403);
      expect(built.auditRecord).toHaveBeenCalledTimes(2);
      for (const call of built.auditRecord.mock.calls) {
        expect(call[0].detail.url).toBe(UNMATCHED_ROUTE);
        expect(call[0].detail.url).not.toContain('secret-token-value');
        expect(call[0].detail.url).not.toContain('a-completely-different-value');
      }
    });
  });
});
