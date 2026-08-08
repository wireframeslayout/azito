import type { FastifyPluginCallback } from 'fastify';
import type { TranscriptService } from './TranscriptService';
import type { TranscriptPaneService } from './TranscriptPaneService';

export interface TranscriptsRouteOptions {
  transcriptService: TranscriptService;
  transcriptPaneService: TranscriptPaneService;
}

const PANE_ID_PATTERN = /^%\d+$/;
const INPUT_TEXT_MIN_LENGTH = 1;
const INPUT_TEXT_MAX_LENGTH = 32768;

const transcriptsRoutes: FastifyPluginCallback<TranscriptsRouteOptions> = (fastify, opts, done) => {
  const { transcriptService, transcriptPaneService } = opts;

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

  // ── GET /api/transcripts/:sessionId/panes ── cwd ベースの候補ペイン一覧
  fastify.get<{ Params: { sessionId: string } }>(
    '/api/transcripts/:sessionId/panes',
    async (request, reply) => {
      const { sessionId } = request.params;
      const result = await transcriptPaneService.listPaneCandidates(sessionId);
      if (!result) return reply.status(404).send({ error: 'Session not found' });
      return result;
    },
  );

  // ── POST /api/transcripts/:sessionId/input ── 指定ペインへプロンプトを送信
  fastify.post<{ Params: { sessionId: string }; Body: { paneId?: unknown; text?: unknown } }>(
    '/api/transcripts/:sessionId/input',
    async (request, reply) => {
      const { sessionId } = request.params;
      const { paneId, text } = request.body ?? {};

      if (typeof paneId !== 'string' || !PANE_ID_PATTERN.test(paneId)) {
        return reply.status(400).send({ error: 'Invalid paneId' });
      }
      if (typeof text !== 'string' || text.length < INPUT_TEXT_MIN_LENGTH || text.length > INPUT_TEXT_MAX_LENGTH) {
        return reply.status(400).send({ error: 'Invalid text' });
      }

      const result = await transcriptPaneService.sendInput(sessionId, paneId, text);
      if (result === 'session_not_found') return reply.status(404).send({ error: 'Session not found' });
      if (result === 'pane_not_found') return reply.status(404).send({ error: 'Pane not found' });
      return { ok: true };
    },
  );

  done();
};

export default transcriptsRoutes;
