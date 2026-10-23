import type { FastifyPluginCallback } from 'fastify';
import { AGENT_HOST_PATH, type AgentHostInfo } from '../modules/servers/transport/agentHostProtocol';

export interface HostRoutesOptions {
  /** Resolved once at startup by the agent's entry point; the route reports it as it is. */
  host: AgentHostInfo;
}

/**
 * The agent's report of the host it runs on (OS, architecture, default shell). It is registered after the token check
 * like every /api route and is deliberately not part of `/health`, which needs no token: what the host is is not for
 * anyone who can reach the port.
 */
const hostRoutes: FastifyPluginCallback<HostRoutesOptions> = (fastify, opts, done) => {
  fastify.get(AGENT_HOST_PATH, async () => opts.host);
  done();
};

export default hostRoutes;
