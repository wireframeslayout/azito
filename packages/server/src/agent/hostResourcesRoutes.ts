import type { FastifyPluginCallback } from 'fastify';
import { AGENT_HOST_RESOURCES_PATH, type HostResourceSample } from '../shared/os/hostResources';

export interface HostResourcesRoutesOptions {
  /** Measures this host (`measureHostResources` with the agent's own system drive), resolved once at startup. */
  measure: () => Promise<HostResourceSample>;
}

/**
 * The memory and disk of the agent's host, for the hub's resource guard. Registered after the token check like every /api route
 * and deliberately not part of `/health`. A host that cannot be measured is a 500 with the reason, not an empty body.
 */
const hostResourcesRoutes: FastifyPluginCallback<HostResourcesRoutesOptions> = (fastify, opts, done) => {
  fastify.get(AGENT_HOST_RESOURCES_PATH, async () => opts.measure());
  done();
};

export default hostResourcesRoutes;
