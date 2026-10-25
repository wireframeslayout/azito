import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type { KeyedMutex } from '../../../shared/keyedMutex';
import { requireOperator } from '../../../shared/auth/requireOperator';
import { HostProfileError } from '../../../shared/os/hostProfile';
import type { IServerRepository } from '../Server';
import type { AgentInstaller } from './AgentInstaller';

export interface AgentUninstallRoutesOptions {
  serverRepo: Pick<IServerRepository, 'findByName'>;
  agentInstaller: Pick<AgentInstaller, 'uninstallFromWindowsHost'>;
  /** The per-server-name lock the other server routes, the updater and the watchdog take. */
  serverIsolationMutex: Pick<KeyedMutex, 'withLock'>;
}

const bodySchema = z.object({ removeMisao: z.boolean().default(false) }).strict();

/**
 * `POST /api/servers/:name/agent/uninstall`: takes the agent off its host (Windows only in this release; Linux / macOS are #499).
 * Operator-only in both auth modes: it deletes software on a machine. It never touches the server row: `DELETE /api/servers/:name`
 * does that, so a host that is offline can still be forgotten. The answer is `{ ok, steps }`, one entry per step with its outcome
 * (`done` / `absent` / `failed` / `skipped` and why), and `ok` is false when any step failed. A host that cannot be reached at all is
 * an error answer (nothing was done).
 *
 * Runs inside the server's lock and reads the server again there, so it cannot interleave with a reinstall, an update, or the watchdog
 * restarting the agent it is removing.
 */
const agentUninstallRoutes: FastifyPluginCallback<AgentUninstallRoutesOptions> = (fastify, opts, done) => {
  const { serverRepo, agentInstaller, serverIsolationMutex } = opts;

  fastify.post<{ Params: { name: string }; Body: unknown }>(
    '/api/servers/:name/agent/uninstall',
    { preHandler: requireOperator('servers.agent_uninstall') },
    async (request, reply) => {
      const body = bodySchema.safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send({ error: 'invalid_body', message: body.error.message });
      return serverIsolationMutex.withLock(request.params.name, async () => {
        const srv = serverRepo.findByName(request.params.name);
        if (!srv) return reply.status(404).send({ error: 'Server not found' });
        // `hostProfile` null is a Unix agent registered before the OS was kept.
        if (srv.type !== 'agent' || srv.hostProfile?.platform !== 'win32') {
          throw new HostProfileError('unsupported_os', `Removing the agent from its host is only supported for Windows agents in this release; for a Linux or macOS host, remove it by hand (see docs/en/install-and-update.md) — tracked in #499.`);
        }
        const sshHost = srv.sshHost || srv.host;
        if (!sshHost) return reply.status(400).send({ error: 'No SSH host configured for this server' });
        return agentInstaller.uninstallFromWindowsHost(sshHost, { removeMisao: body.data.removeMisao });
      });
    },
  );

  done();
};

export default agentUninstallRoutes;
