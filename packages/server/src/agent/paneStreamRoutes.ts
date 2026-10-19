import type { FastifyPluginCallback } from 'fastify';
import { AGENT_PANE_STREAMS_PATH } from '../modules/servers/transport/agentPaneStreamProtocol';
import { InvalidStreamFileError, type ManagedStreamFiles } from '../modules/files/ws/ManagedStreamFiles';

export interface PaneStreamRoutesOptions {
  managed: ManagedStreamFiles;
}

/**
 * ハブの `AgentPaneStream` が、pane の出力を追跡させるファイルを登録・解除する API。登録されたファイルだけが
 * `/ws?mode=file-tail` で読める（`fileTailHandler`）。エージェントのトークン認証（main.ts の onRequest フック）の
 * 配下に登録すること。
 */
const paneStreamRoutes: FastifyPluginCallback<PaneStreamRoutesOptions> = (fastify, opts, done) => {
  const { managed } = opts;

  fastify.post<{ Body: { path?: unknown } }>(AGENT_PANE_STREAMS_PATH, async (request, reply) => {
    const filePath = request.body?.path;
    if (typeof filePath !== 'string') return reply.status(400).send({ error: 'path required' });
    try {
      managed.register(filePath);
    } catch (err) {
      if (err instanceof InvalidStreamFileError) return reply.status(400).send({ error: err.message });
      throw err;
    }
    return { ok: true };
  });

  fastify.delete<{ Querystring: { path?: string } }>(AGENT_PANE_STREAMS_PATH, async (request, reply) => {
    const filePath = request.query.path;
    if (!filePath) return reply.status(400).send({ error: 'path required' });
    managed.unregister(filePath);
    return { ok: true };
  });

  done();
};

export default paneStreamRoutes;
