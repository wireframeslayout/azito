import type { FastifyPluginCallback } from 'fastify';
import type { IServerRepository, ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { MisaoConnection } from '../../tmux/misao/MisaoConnection';
import { describeMisaoDaemon } from '../../tmux/misao/misaoDriver';
import type { MisaoServers } from '../../tmux/misao/MisaoServers';
import type { KeyedMutex } from '../../../shared/keyedMutex';
import type { MisaoAgentInstaller } from './MisaoAgentInstaller';
import { MisaoServiceError } from './MisaoServiceError';
import { MISAO_ERROR_STATUS, requireOperator } from './misaoRouteSupport';

export interface AgentMisaoRoutesOptions {
  serverRepo: Pick<IServerRepository, 'findByName'>;
  transportFactory: Pick<TransportFactory, 'getAgentTransport'>;
  installer: Pick<MisaoAgentInstaller, 'install'>;
  misaoServers: Pick<MisaoServers, 'ensureAgentNode'>;
  /** The per-server-name lock the other server routes use, so an install cannot interleave with an edit or a window creation. */
  serverIsolationMutex: Pick<KeyedMutex, 'withLock'>;
  /** The server now has a misao (or a new one): drop what the hub cached about its sessions. */
  onInstalled: (server: ServerConfig) => void;
  /** How long to wait for the hub's connection to the new daemon before answering with whatever state it is in. */
  connectTimeoutMs?: number;
}

/** What the last install-misao run of a server is doing / did, for the UI to show while the POST is still in flight. */
export interface MisaoInstallProgress {
  state: 'idle' | 'running' | 'done' | 'failed';
  /** Every step reported so far, in order (`MisaoInstallStep` codes); the last one is what is happening now. */
  steps: string[];
  error?: string;
  code?: string;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_POLL_MS = 100;

async function waitUntilAvailable(connection: Pick<MisaoConnection, 'availability'>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !connection.availability().available) {
    await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS));
  }
}

/**
 * `POST /api/servers/:name/install-misao`: puts the bundled misao on an agent server and connects the hub to it. It hands
 * a host its pane server (a daemon that runs commands as the agent's user), so it is operator-only in both auth modes.
 * Two things trigger it: the install of a new agent server, and a misao window being asked for on a server that has none
 * (the UI asks the operator first, then calls this). `GET` on the same path reports how the last run is going.
 */
const agentMisaoRoutes: FastifyPluginCallback<AgentMisaoRoutesOptions> = (fastify, opts, done) => {
  const { serverRepo, transportFactory, installer, misaoServers, serverIsolationMutex, onInstalled } = opts;
  const progress = new Map<string, MisaoInstallProgress>();

  // Nothing secret is in it: the steps are fixed phrases and the error is the refusal the POST answers with.
  fastify.get<{ Params: { name: string } }>('/api/servers/:name/install-misao', async (request, reply) => {
    if (!serverRepo.findByName(request.params.name)) return reply.status(404).send({ error: 'Server not found' });
    return progress.get(request.params.name) ?? ({ state: 'idle', steps: [] } satisfies MisaoInstallProgress);
  });

  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/install-misao',
    { preHandler: requireOperator('servers.install_misao') },
    async (request, reply) => serverIsolationMutex.withLock(request.params.name, async () => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      if (srv.type !== 'agent') {
        return reply.status(400).send({ error: "A local server's misao is installed from Settings > System (/api/system/misao/install).", code: 'usage' });
      }

      const steps: string[] = [];
      progress.set(srv.name, { state: 'running', steps: [] });
      try {
        const result = await installer.install(transportFactory.getAgentTransport(srv), (message) => {
          steps.push(message);
          progress.set(srv.name, { state: 'running', steps: [...steps] });
        });
        const node = misaoServers.ensureAgentNode(srv);
        await waitUntilAvailable(node.connection, opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
        onInstalled(srv);
        const daemon = await describeMisaoDaemon(node.connection);
        progress.set(srv.name, { state: 'done', steps });
        return { ok: true, ...result, steps, daemon };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        progress.set(srv.name, { state: 'failed', steps, error: message, ...(err instanceof MisaoServiceError ? { code: err.code } : {}) });
        // A refusal is answered with its code; anything else (the agent is unreachable) is the global error handler's.
        if (!(err instanceof MisaoServiceError)) throw err;
        return reply.status(MISAO_ERROR_STATUS[err.code]).send({ error: message, code: err.code, steps });
      }
    }),
  );

  done();
};

export default agentMisaoRoutes;
