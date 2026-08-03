import type { FastifyPluginCallback } from 'fastify';
import { getReleaseInfo } from '../../shared/releaseInfo';
import type { DeployModeDetector } from '../system/DeployModeDetector';

interface HealthRouteOptions {
  deployModeDetector: DeployModeDetector;
}

const healthRoutes: FastifyPluginCallback<HealthRouteOptions> = (fastify, opts, done) => {
  const { deployModeDetector } = opts;

  fastify.get('/api/health', async () => {
    const release = getReleaseInfo();
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      version: release?.version ?? 'dev',
      deployMode: deployModeDetector.detect(),
      ...(release && {
        commit: release.commit,
        bundleHash: release.bundleHash,
      }),
    };
  });

  done();
};

export default healthRoutes;
