import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import browserRoutes, { type BrowserRouteOptions } from '../routes';
import { SqliteBrowserGroupRepository } from '../SqliteBrowserGroupRepository';
import { openDatabase, type SqliteDatabase } from '../../../shared/db/Database';
import { SqliteTaskTokenRepository } from '../../tasks/tokens/SqliteTaskTokenRepository';
import { AuditLogService } from '../../../shared/audit/AuditLogService';
import { resolvePrincipal } from '../../../shared/auth/resolvePrincipal';
import { evaluateRouteAuth } from '../../../shared/auth/routeAuth';
import { createTokenVerifier } from '../../servers/auth/tokenAuth';

// Integration coverage for Issue #28 Phase E (design v3 §11): task-owned
// browser groups. Mirrors modules/tasks/childrenRoute.integration.test.ts's
// approach — wires the REAL onRequest auth pipeline (resolvePrincipal +
// evaluateRouteAuth, same as app/buildServer.ts's hook) in front of
// browserRoutes, since group-ownership scoping only exists at that
// boundary, not inside a route-body-only test.

const UI_TOKEN = 'operator-ui-token';

function buildApp(scopedAuthEnabled: boolean, db: SqliteDatabase): {
  app: FastifyInstance;
  taskTokenRepo: SqliteTaskTokenRepository;
  browserGroupRepo: SqliteBrowserGroupRepository;
  auditRecord: ReturnType<typeof vi.fn>;
} {
  const taskTokenRepo = new SqliteTaskTokenRepository(db);
  const browserGroupRepo = new SqliteBrowserGroupRepository(db);
  const verifyUiToken = createTokenVerifier(UI_TOKEN);
  const auditRecord = vi.fn();
  const auditLogService = new AuditLogService({ record: auditRecord, listRecent: vi.fn(() => []) });

  const mockPage = { targetId: 'target-abc', dispatchInput: vi.fn(async () => {}) };
  const mockSession = { getOrCreatePage: vi.fn(async () => mockPage), setGroupHold: vi.fn() };
  const browserSessionManager = {
    getOrCreate: vi.fn(async () => mockSession),
    closeGroup: vi.fn(async () => {}),
  } as unknown as BrowserRouteOptions['browserSessionManager'];
  const serverRepo = {
    findByName: vi.fn(() => ({ type: 'local', name: 'srv1' })),
  } as unknown as BrowserRouteOptions['serverRepo'];

  const opts: BrowserRouteOptions = {
    browserSessionManager,
    serverRepo,
    browserGroupRepo,
    auditLogService,
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
  app.register(browserRoutes, opts);

  return { app, taskTokenRepo, browserGroupRepo, auditRecord };
}

describe('Task-owned browser groups (Issue #28 Phase E, design v3 §11)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('POST /api/browser/open with a task token records ownership and strips cdpEndpoint from the response', async () => {
    const { app, taskTokenRepo, browserGroupRepo } = buildApp(true, db);
    const { token } = taskTokenRepo.issue(1, 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      headers: { authorization: `Bearer ${token}` },
      payload: { server: 'srv1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.cdpEndpoint).toBeUndefined();
    expect(body.groupId).toMatch(/^agent-/);
    expect(browserGroupRepo.findOwnerTaskId('srv1', body.groupId)).toBe(1);
  });

  it('POST /api/browser/open with the operator UI token keeps cdpEndpoint in the response', async () => {
    const { app } = buildApp(true, db);

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      headers: { authorization: `Bearer ${UI_TOKEN}` },
      payload: { server: 'srv1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().cdpEndpoint).toBe('http://127.0.0.1:9222');
  });

  it('a task principal ignores a client-supplied taskId and always owns the group under its OWN task id', async () => {
    const { app, taskTokenRepo, browserGroupRepo } = buildApp(true, db);
    const { token } = taskTokenRepo.issue(1, 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      headers: { authorization: `Bearer ${token}` },
      payload: { server: 'srv1', taskId: 999 },
    });

    expect(res.statusCode).toBe(200);
    const { groupId } = res.json();
    expect(browserGroupRepo.findOwnerTaskId('srv1', groupId)).toBe(1);
  });

  it("review fix 1: an operator open with a body taskId never grants that task's token close authority (metadata is not authorization)", async () => {
    const { app, taskTokenRepo, browserGroupRepo } = buildApp(true, db);
    const { token: victimToken } = taskTokenRepo.issue(7, 1);

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      headers: { authorization: `Bearer ${UI_TOKEN}` },
      // An operator's own open, carrying an unverified `taskId` in the
      // body — this must stay pure metadata (e.g. for the browser:opened
      // notification), never become the recorded owner.
      payload: { server: 'srv1', taskId: 7 },
    });
    const { groupId } = openRes.json();
    expect(browserGroupRepo.findOwnerTaskId('srv1', groupId)).toBeNull();

    const closeRes = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      headers: { authorization: `Bearer ${victimToken}` },
      payload: { server: 'srv1', group: groupId },
    });

    expect(closeRes.statusCode).toBe(403);
    expect(closeRes.json()).toEqual({ error: 'operator_required', operation: 'browser.close_group' });
    // The group is untouched by the denied attempt.
    expect(browserGroupRepo.findOwnerTaskId('srv1', groupId)).toBeNull();
  });

  it('a task principal can close-group the group it opened', async () => {
    const { app, taskTokenRepo, browserGroupRepo } = buildApp(true, db);
    const { token } = taskTokenRepo.issue(1, 1);

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      headers: { authorization: `Bearer ${token}` },
      payload: { server: 'srv1' },
    });
    const { groupId } = openRes.json();

    const closeRes = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      headers: { authorization: `Bearer ${token}` },
      payload: { server: 'srv1', group: groupId },
    });

    expect(closeRes.statusCode).toBe(200);
    // Ownership row is cleaned up on a successful close.
    expect(browserGroupRepo.findOwnerTaskId('srv1', groupId)).toBeUndefined();
  });

  it("a task principal is rejected with 403 when it tries to close-group ANOTHER task's group (Issue #28 Phase E core requirement)", async () => {
    const { app, taskTokenRepo, browserGroupRepo, auditRecord } = buildApp(true, db);
    const opener = taskTokenRepo.issue(1, 1);
    const attacker = taskTokenRepo.issue(2, 1);

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      headers: { authorization: `Bearer ${opener.token}` },
      payload: { server: 'srv1' },
    });
    const { groupId } = openRes.json();

    const closeRes = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      headers: { authorization: `Bearer ${attacker.token}` },
      payload: { server: 'srv1', group: groupId },
    });

    expect(closeRes.statusCode).toBe(403);
    expect(closeRes.json()).toEqual({ error: 'operator_required', operation: 'browser.close_group' });
    // The group survives — task 2's failed attempt must not affect task 1's ownership.
    expect(browserGroupRepo.findOwnerTaskId('srv1', groupId)).toBe(1);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ actorClass: 'task', actorId: 2, event: 'browser.close_group.denied' }),
    );
  });

  it('an operator can close-group any group regardless of ownership', async () => {
    const { app, taskTokenRepo } = buildApp(true, db);
    const owner = taskTokenRepo.issue(1, 1);

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/browser/open',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { server: 'srv1' },
    });
    const { groupId } = openRes.json();

    const closeRes = await app.inject({
      method: 'POST',
      url: '/api/browser/close-group',
      headers: { authorization: `Bearer ${UI_TOKEN}` },
      payload: { server: 'srv1', group: groupId },
    });

    expect(closeRes.statusCode).toBe(200);
  });
});
