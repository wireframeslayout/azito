import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import storageRoutes, { type StorageRouteOptions } from './routes';
import { openDatabase, type SqliteDatabase } from '../../shared/db/Database';
import { SqliteTaskTokenRepository } from '../tasks/tokens/SqliteTaskTokenRepository';
import { resolvePrincipal } from '../../shared/auth/resolvePrincipal';
import { evaluateRouteAuth, type RouteAuthRequirement } from '../../shared/auth/routeAuth';
import { createTokenVerifier } from '../servers/auth/tokenAuth';
import type { Principal } from '../../shared/auth/Principal';

// Integration coverage for Issue #28 Phase E requirement 5 (design v3 §11):
// scoping POST /api/projects/:id/storage/upload — the route browser-ops
// uses to save screenshots/assets — to a task principal's OWN project.
// Mirrors modules/tasks/childrenRoute.integration.test.ts's approach: wires
// the REAL onRequest auth pipeline in front of storageRoutes, since the
// scoping only exists at that boundary.

const UI_TOKEN = 'operator-ui-token';

function buildApp(uploadAuth: RouteAuthRequirement, db: SqliteDatabase): {
  app: FastifyInstance;
  taskTokenRepo: SqliteTaskTokenRepository;
  uploadSpy: ReturnType<typeof vi.fn>;
} {
  const taskTokenRepo = new SqliteTaskTokenRepository(db);
  const verifyUiToken = createTokenVerifier(UI_TOKEN);

  const uploadSpy = vi.fn(async () => ({ name: 'stored.txt', size: 5, url: 'http://minio/stored.txt' }));
  const opts: StorageRouteOptions = {
    projectRepo: { findById: vi.fn((id: number) => ({ id, name: 'P', slug: 'p' })) } as unknown as StorageRouteOptions['projectRepo'],
    storageSettingsRepo: { get: vi.fn(() => ({ endpoint: 'x', accessKey: 'a', secretKey: 'b', bucket: 'bkt', region: 'us-east-1', useSsl: false, maxFileSize: 10_000_000 })) } as unknown as StorageRouteOptions['storageSettingsRepo'],
    storageClient: { ensureBucket: vi.fn(async () => {}), upload: uploadSpy } as unknown as StorageRouteOptions['storageClient'],
    uploadAuth,
  };

  const app = Fastify();
  app.register(multipart);
  // Mirrors app/buildServer.ts's onRequest hook (principal resolution +
  // evaluateRouteAuth), scoped to this test's app only — always in
  // "scoped auth enabled" mode so a denial actually 403s (the real hook
  // only 403s once AZITO_SCOPED_AUTH is on; this test exists to verify the
  // condition itself, independent of that rollout flag).
  app.addHook('onRequest', async (request, reply) => {
    const principal = resolvePrincipal(request.headers.authorization, { verifyUiToken, taskTokenRepo });
    if (!principal) return reply.status(401).send({ error: 'Unauthorized' });
    request.principal = principal;
    const { allowed, operation } = evaluateRouteAuth(principal, request);
    if (!allowed) return reply.status(403).send({ error: 'operator_required', operation });
  });
  app.register(storageRoutes, opts);

  return { app, taskTokenRepo, uploadSpy };
}

function makeUploadAuth(taskProjectId: (taskId: number) => number | undefined): RouteAuthRequirement {
  return {
    classes: ['task'],
    operation: 'storage.upload',
    condition: (principal: Principal, request) => {
      const projectId = Number((request.params as { id: string }).id);
      if (!Number.isInteger(projectId)) return false;
      if (principal.id === undefined) return false;
      return taskProjectId(principal.id) === projectId;
    },
  };
}

describe('POST /api/projects/:id/storage/upload — task-principal scoping (Issue #28 Phase E requirement 5)', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it("a task principal can upload into its OWN task's project", async () => {
    const uploadAuth = makeUploadAuth((taskId) => (taskId === 1 ? 10 : undefined));
    const { app, taskTokenRepo, uploadSpy } = buildApp(uploadAuth, db);
    const { token } = taskTokenRepo.issue(1, 1);

    const fd = new FormData();
    fd.set('file', new Blob([Buffer.from('hello')]), 'a.txt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/storage/upload',
      headers: { authorization: `Bearer ${token}` },
      payload: fd,
    });

    expect(res.statusCode).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
  });

  it("a task principal is rejected with 403 when uploading into ANOTHER project", async () => {
    const uploadAuth = makeUploadAuth((taskId) => (taskId === 1 ? 10 : undefined));
    const { app, taskTokenRepo, uploadSpy } = buildApp(uploadAuth, db);
    const { token } = taskTokenRepo.issue(1, 1);

    const fd = new FormData();
    fd.set('file', new Blob([Buffer.from('hello')]), 'a.txt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/999/storage/upload',
      headers: { authorization: `Bearer ${token}` },
      payload: fd,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'operator_required', operation: 'storage.upload' });
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('an operator can upload into any project regardless of the auth condition', async () => {
    const uploadAuth = makeUploadAuth(() => undefined);
    const { app, uploadSpy } = buildApp(uploadAuth, db);

    const fd = new FormData();
    fd.set('file', new Blob([Buffer.from('hello')]), 'a.txt');
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/10/storage/upload',
      headers: { authorization: `Bearer ${UI_TOKEN}` },
      payload: fd,
    });

    expect(res.statusCode).toBe(200);
    expect(uploadSpy).toHaveBeenCalled();
  });
});
