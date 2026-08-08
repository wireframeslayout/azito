import type { FastifyPluginCallback } from 'fastify';
import type { AgentSignalService } from './AgentSignalService';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';

export interface AgentSignalRouteOptions {
  agentSignalService: AgentSignalService;
  verifyToken: (authHeader: string | undefined) => boolean;
  auditLogService: AuditLogService;
}

/**
 * `POST /api/agent-signals` accepts two independent proofs of identity
 * (design v3 §8): the shared `AZITO_WEBHOOK_TOKEN` bearer (legacy — kept so
 * an older `azitoctl` on a not-yet-updated remote server keeps working), OR
 * the request body's `turnToken` alone. A turnToken is a 128-bit random
 * nonce (see AgentTurn.ts's buildTurnToken doc comment) minted per turn and
 * known only to the hub and the worker process it was handed to, so it is
 * itself sufficient proof — requiring the webhook token on top of it would
 * only reintroduce the shared-secret dependency Phase C removes.
 *
 * Neither credential is required to be ABSENT; a caller may send both (an
 * updated azitoctl still has the webhook token available in its config and
 * sends it opportunistically) or either alone. AgentSignalService is the
 * actual arbiter of turnToken validity — it resolves the turn and rejects a
 * turnToken that doesn't match (see its 403/404 branches) — so this route
 * only decides, for audit purposes, which credential the caller presented.
 *
 * A terminal signal (`complete`/`fail`/a `questions` transition) is
 * one-shot: AgentSignalService.handleSignal transitions the addressed turn
 * out of `running` when it applies one, and a turnToken that resolves to a
 * non-`running` turn is answered with a 200 "duplicate" no-op rather than
 * re-applying the signal (see AgentSignalService's `turn.status !==
 * 'running'` branch) — so a leaked/replayed terminal turnToken cannot be
 * used to re-open or re-signal a turn that has already closed.
 */
const agentSignalRoutes: FastifyPluginCallback<AgentSignalRouteOptions> = (fastify, opts, done) => {
  const { agentSignalService, verifyToken, auditLogService } = opts;

  fastify.post('/api/agent-signals', async (request, reply) => {
    const webhookAuthenticated = verifyToken(request.headers.authorization);

    const result = agentSignalService.handleSignal(request.body);

    // Record which credential actually authenticated the request (design v3
    // §8: "認証成立の根拠（webhook / turnToken）を監査ログに記録"). Only
    // logged on a successful outcome — a 4xx here already means neither
    // credential was accepted (webhook absent/invalid AND turnToken didn't
    // resolve to a matching running turn), so there is no "basis" to record,
    // and AgentSignalService already appends an 'invalid' turn event for a
    // turnToken/turn mismatch. detail carries no secret value, per the
    // audit_log doc comment on migration 060.
    if (result.status === 200) {
      try {
        auditLogService.record({
          actorClass: 'runtime',
          actorId: null,
          event: 'agent_signal.authenticated',
          detail: { basis: webhookAuthenticated ? 'webhook' : 'turn_token' },
        });
      } catch (err) {
        request.log.error({ err }, 'agent_signal audit log write failed; continuing');
      }
    }

    return reply.status(result.status).send(result.body);
  });

  done();
};

export default agentSignalRoutes;
