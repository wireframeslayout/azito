import type { FastifyPluginCallback } from 'fastify';
import { AGENT_PROCESSES_PATH, type ProcessEntry } from '../shared/os/processList';

export interface ProcessRoutesOptions {
  /** Lists the processes of this host (`listProcessesWith` on the agent's own platform), resolved once at startup. */
  listProcesses: () => Promise<ProcessEntry[]>;
}

/**
 * The processes of the agent's host (pid / ppid / start time / executable / command line), the same list the hub builds for
 * its own server. Registered after the token check like every /api route. A host that cannot list them is a 500 with the
 * reason, not an empty list.
 */
const processRoutes: FastifyPluginCallback<ProcessRoutesOptions> = (fastify, opts, done) => {
  fastify.get(AGENT_PROCESSES_PATH, async () => opts.listProcesses());
  done();
};

export default processRoutes;
