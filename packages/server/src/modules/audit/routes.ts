import type { FastifyPluginCallback } from 'fastify';
import type { AuditLogService } from '../../shared/audit/AuditLogService';

// ─── Types ───

export interface AuditLogRouteOptions {
  auditLogService: AuditLogService;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ─── Plugin ───
//
// Issue #28 Phase D-4 (design v3 §10 "可視化" — minimal read-only view onto
// audit_log). Operator-only: this route registers no `config.auth`, which
// evaluateRouteAuth() (shared/auth/routeAuth.ts) defaults to operator-only
// ("A route with no auth config at all defaults to operator-only") — no
// explicit auth wiring needed here.

const auditLogRoutes: FastifyPluginCallback<AuditLogRouteOptions> = (fastify, opts, done) => {
  const { auditLogService } = opts;

  // ── GET /api/audit-log?limit= ── most recent audit_log rows, newest first. No filtering — kept deliberately minimal (design doc: advanced UI is out of scope).
  fastify.get('/api/audit-log', async (request, reply) => {
    const query = request.query as { limit?: string };
    let limit = DEFAULT_LIMIT;
    if (query.limit !== undefined) {
      const parsed = Number(query.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return reply.status(400).send({ error: 'limit must be a positive integer' });
      }
      limit = Math.min(parsed, MAX_LIMIT);
    }
    return auditLogService.list(limit);
  });

  done();
};

export default auditLogRoutes;
