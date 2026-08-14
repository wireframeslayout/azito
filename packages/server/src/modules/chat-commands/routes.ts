import type { FastifyPluginCallback } from 'fastify';
import type { ChatCommandLoader } from './ChatCommandLoader';

export interface ChatCommandsRouteOptions {
  chatCommandLoader: ChatCommandLoader;
}

/** GET /api/chat-commands?worker_type=claude — 認証は他の /api 同様、onRequest フックで一括適用される。 */
const chatCommandsRoutes: FastifyPluginCallback<ChatCommandsRouteOptions> = (fastify, opts, done) => {
  const { chatCommandLoader } = opts;

  fastify.get<{ Querystring: { worker_type?: string } }>('/api/chat-commands', async (request, reply) => {
    const workerType = request.query.worker_type;
    if (!workerType) {
      return reply.status(400).send({ error: 'worker_type is required' });
    }
    return { commands: chatCommandLoader.listForAgentType(workerType) };
  });

  done();
};

export default chatCommandsRoutes;
