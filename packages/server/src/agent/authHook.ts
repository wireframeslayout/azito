import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The agent's onRequest auth check: every route except /health and the same-host tmux hook receiver needs the
 * hub's bearer token. Routes registered after `app.addHook('onRequest', agentAuthHook(...))` are covered by it.
 */
export function agentAuthHook(
  verifyToken: (authHeader: string | undefined) => boolean,
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined> {
  return async (request, reply) => {
    if (request.url.startsWith('/health')) return;
    if (request.url.startsWith('/api/hooks/tmux')) return;
    if (!verifyToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  };
}
