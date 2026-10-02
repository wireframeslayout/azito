import type { FastifyPluginCallback } from 'fastify';
import { getReleaseInfo } from '../../shared/releaseInfo';
import type { DeployModeDetector } from '../system/DeployModeDetector';

interface HealthRouteOptions {
  deployModeDetector: DeployModeDetector;
  // Issue #28 third-party review Important finding: the frontend previously
  // had no way to tell whether scoped authorization (AZITO_SCOPED_AUTH) is
  // actually enforced or the hub is still in compat mode (a UI token is
  // deliberately injected into every task pane's env) — surfaced here
  // instead of a new endpoint, since /api/health is already an unauthenticated,
  // polled-at-startup source of hub-wide capability flags (see deployMode
  // above). See TaskOwnedPaneBadge.tsx for the one consumer.
  scopedAuthEnabled: boolean;
  // AZITO_EXPERIMENTAL_MISAO: lets the frontend offer the misao mux runtime.
  // Omitted from the response when off so the payload is unchanged by default.
  misaoEnabled: boolean;
}

const healthRoutes: FastifyPluginCallback<HealthRouteOptions> = (fastify, opts, done) => {
  const { deployModeDetector, scopedAuthEnabled, misaoEnabled } = opts;

  fastify.get('/api/health', async () => {
    const release = getReleaseInfo();
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      version: release?.version ?? 'dev',
      deployMode: deployModeDetector.detect(),
      scopedAuthEnabled,
      ...(misaoEnabled && { experimentalMisao: true }),
      ...(release && {
        commit: release.commit,
        bundleHash: release.bundleHash,
      }),
    };
  });

  done();
};

export default healthRoutes;
