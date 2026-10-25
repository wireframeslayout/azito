import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Operations that can end every pane, hand a host its pane server or remove software from a host need the operator principal in both
 * auth modes: the global hook only enforces operator-only routes when AZITO_SCOPED_AUTH is on, and in compat mode a task token passes it.
 */
export function requireOperator(operation: string): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (request.principal?.class !== 'operator') {
      await reply.status(403).send({ error: 'operator_required', operation });
    }
  };
}
