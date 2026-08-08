import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createTokenVerifier } from '../modules/servers/auth/tokenAuth';
import { resolvePrincipal } from '../shared/auth/resolvePrincipal';
import { evaluateRouteAuth } from '../shared/auth/routeAuth';
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
        detail: { operation },
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
});
