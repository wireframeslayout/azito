import type { FastifyPluginCallback } from 'fastify';
import type { AgentSignalService } from './AgentSignalService';

export interface AgentSignalRouteOptions {
  agentSignalService: AgentSignalService;
  verifyToken: (authHeader: string | undefined) => boolean;
}

const agentSignalRoutes: FastifyPluginCallback<AgentSignalRouteOptions> = (fastify, opts, done) => {
  const { agentSignalService, verifyToken } = opts;

  fastify.post('/api/agent-signals', async (request, reply) => {
    if (!verifyToken(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const result = agentSignalService.handleSignal(request.body);
    return reply.status(result.status).send(result.body);
  });

  done();
};

export default agentSignalRoutes;
