import type { FastifyPluginCallback } from 'fastify';
import type { TranscriptService } from './TranscriptService';

export interface TranscriptsRouteOptions {
  transcriptService: TranscriptService;
}

const transcriptsRoutes: FastifyPluginCallback<TranscriptsRouteOptions> = (fastify, opts, done) => {
  const { transcriptService } = opts;

  // ── GET /api/transcripts ── セッション一覧（mtime 降順）
  fastify.get('/api/transcripts', async () => {
    return { sessions: transcriptService.listSessions() };
  });

  // ── GET /api/transcripts/:sessionId ── 単一セッションの読み取り（offset で差分読み）
  fastify.get<{ Params: { sessionId: string }; Querystring: { offset?: string } }>(
    '/api/transcripts/:sessionId',
    async (request, reply) => {
      const { sessionId } = request.params;
      const rawOffset = request.query.offset;
      const offset = rawOffset !== undefined ? Number(rawOffset) : undefined;
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
        return reply.status(400).send({ error: 'Invalid offset' });
      }

      const result = transcriptService.readSession(sessionId, offset);
      if (!result) return reply.status(404).send({ error: 'Session not found' });
      return result;
    },
  );

  done();
};

export default transcriptsRoutes;
