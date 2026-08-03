import type { FastifyPluginCallback } from 'fastify';
import type { SupervisorRegistry } from './SupervisorRegistry';

export interface SupervisorsRouteOptions {
  supervisorRegistry: SupervisorRegistry;
}

/** Debug/inspection endpoint — no auth (LAN-only assumption, matches /api/operations, /api/agent-activity). */
const supervisorsRoutes: FastifyPluginCallback<SupervisorsRouteOptions> = (fastify, opts, done) => {
  const { supervisorRegistry } = opts;

  // ── GET /api/supervisors ── snapshot of currently connected tui-supervisor processes
  fastify.get('/api/supervisors', async () => supervisorRegistry.snapshot());

  done();
};

export default supervisorsRoutes;
