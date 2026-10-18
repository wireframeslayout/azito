import type { FastifyReply, FastifyRequest } from 'fastify';
import { MisaoServiceError, type MisaoServiceErrorCode } from './MisaoServiceError';

/** The HTTP status of a refusal (`MisaoServiceError`): the operation did not happen, and the caller can show why. */
export const MISAO_ERROR_STATUS: Record<MisaoServiceErrorCode, number> = {
  usage: 400,
  not_managed: 409,
  custom_socket: 409,
  not_installed: 409,
  busy: 409,
  daemon_not_ready: 502,
  update_failed: 502,
  unsupported_host: 409,
  transfer_failed: 502,
};

/**
 * Operations that can end every pane (or hand a host its pane server) need the operator principal in both auth modes:
 * the global hook only enforces operator-only routes when AZITO_SCOPED_AUTH is on, and in compat mode a task token passes it.
 */
export function requireOperator(operation: string): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (request.principal?.class !== 'operator') {
      await reply.status(403).send({ error: 'operator_required', operation });
    }
  };
}

/** Runs a misao operation and answers its refusal as `{ error, code }`; anything else is not this route's to explain. */
export async function runMisaoOperation(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (err) {
    if (!(err instanceof MisaoServiceError)) throw err;
    return reply.status(MISAO_ERROR_STATUS[err.code]).send({ error: err.message, code: err.code });
  }
}
