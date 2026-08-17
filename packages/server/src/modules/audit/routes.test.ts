import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import auditLogRoutes from './routes';
import type { AuditLogRow } from '../../shared/audit/AuditLogRepository';

// Issue #28 Phase D-4: GET /api/audit-log?limit= — the route itself is a
// thin passthrough to AuditLogService.list(); auth (operator-only via
// default-deny — no `config.auth` on this route) is covered generically by
// evaluateRouteAuth()'s own tests, not re-verified per-route here.

function buildApp(list: (limit: number) => AuditLogRow[]) {
  const app = Fastify();
  const auditLogService = { list: vi.fn(list) } as unknown as { list: ReturnType<typeof vi.fn> };
  app.register(auditLogRoutes, { auditLogService: auditLogService as never });
  return { app, auditLogService };
}

describe('GET /api/audit-log', () => {
  it('defaults to limit=100 when no query param is given', async () => {
    const { app, auditLogService } = buildApp(() => []);
    const res = await app.inject({ method: 'GET', url: '/api/audit-log' });
    expect(res.statusCode).toBe(200);
    expect(auditLogService.list).toHaveBeenCalledWith(100);
  });

  it('passes through a valid limit', async () => {
    const { app, auditLogService } = buildApp(() => []);
    await app.inject({ method: 'GET', url: '/api/audit-log?limit=25' });
    expect(auditLogService.list).toHaveBeenCalledWith(25);
  });

  it('clamps a limit above the cap to 500', async () => {
    const { app, auditLogService } = buildApp(() => []);
    await app.inject({ method: 'GET', url: '/api/audit-log?limit=999999' });
    expect(auditLogService.list).toHaveBeenCalledWith(500);
  });

  it('rejects a non-positive-integer limit with 400', async () => {
    const { app, auditLogService } = buildApp(() => []);
    const res = await app.inject({ method: 'GET', url: '/api/audit-log?limit=0' });
    expect(res.statusCode).toBe(400);
    expect(auditLogService.list).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit with 400', async () => {
    const { app, auditLogService } = buildApp(() => []);
    const res = await app.inject({ method: 'GET', url: '/api/audit-log?limit=abc' });
    expect(res.statusCode).toBe(400);
    expect(auditLogService.list).not.toHaveBeenCalled();
  });

  it('returns the rows from the service', async () => {
    const row: AuditLogRow = { id: 1, ts: '2026-08-09T00:00:00Z', actorClass: 'operator', actorId: null, event: 'task.created', detail: { taskId: 1 } };
    const { app } = buildApp(() => [row]);
    const res = await app.inject({ method: 'GET', url: '/api/audit-log' });
    expect(res.json()).toEqual([row]);
  });
});
