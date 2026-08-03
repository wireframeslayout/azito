import type { FastifyPluginCallback } from 'fastify';
import type { UsageService } from './UsageService';

export interface UsageRouteOptions {
  usageService: UsageService;
}

const usageRoutes: FastifyPluginCallback<UsageRouteOptions> = (fastify, opts, done) => {
  const { usageService } = opts;

  fastify.get('/api/usage', async () => {
    return usageService.collect();
  });

  done();
};

export default usageRoutes;
