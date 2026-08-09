import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { TranscriptPaneService } from './TranscriptPaneService';

export interface TranscriptsRouteOptions {
  sources: TranscriptSource[];
  transcriptPaneService: TranscriptPaneService;
}

const PANE_ID_PATTERN = /^%\d+$/;
const INPUT_TEXT_MIN_LENGTH = 1;
const INPUT_TEXT_MAX_LENGTH = 32768;
/** pane 候補提示・入力送信は tmux ペインとの cwd 突合が前提のため、現状 Claude のみ対応。 */
const PANE_CAPABLE_AGENT_TYPE = 'claude';

function findSource(sources: TranscriptSource[], agentType: string): TranscriptSource | undefined {
  return sources.find((s) => s.agentType === agentType);
}

/** offset クエリを検証する。未指定は undefined、不正値は 'invalid' を返す。 */
function parseOffset(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset < 0) return 'invalid';
  return offset;
}

const transcriptsRoutes: FastifyPluginCallback<TranscriptsRouteOptions> = (fastify, opts, done) => {
  const { sources, transcriptPaneService } = opts;

  // ── GET /api/transcripts ── 全ソース横断のセッション一覧（mtime 降順）。?agent= で絞り込み可。
  fastify.get<{ Querystring: { agent?: string } }>('/api/transcripts', async (request) => {
    const { agent } = request.query;
    const targetSources = agent ? sources.filter((s) => s.agentType === agent) : sources;
    const sessions = targetSources.flatMap((s) => s.listSessions());
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { sessions };
  });

  // ── GET /api/transcripts/:agent/:id ── 単一セッションの読み取り（offset で差分読み）
  fastify.get<{ Params: { agent: string; id: string }; Querystring: { offset?: string } }>(
    '/api/transcripts/:agent/:id',
    async (request, reply) => {
      const source = findSource(sources, request.params.agent);
      if (!source) return reply.status(404).send({ error: 'Unknown agent type' });

      const offset = parseOffset(request.query.offset);
      if (offset === 'invalid') return reply.status(400).send({ error: 'Invalid offset' });

      const result = source.readSession(request.params.id, offset);
      if (!result) return reply.status(404).send({ error: 'Session not found' });
      return result;
    },
  );

  // ── GET /api/transcripts/:agent/:id/panes ── cwd ベースの候補ペイン一覧（claude のみ対応）
  fastify.get<{ Params: { agent: string; id: string } }>('/api/transcripts/:agent/:id/panes', async (request, reply) => {
    if (request.params.agent !== PANE_CAPABLE_AGENT_TYPE) {
      return reply.status(501).send({ error: `Pane matching is not supported for agent type "${request.params.agent}"` });
    }
    const result = await transcriptPaneService.listPaneCandidates(request.params.id);
    if (!result) return reply.status(404).send({ error: 'Session not found' });
    return result;
  });

  // ── POST /api/transcripts/:agent/:id/input ── 指定ペインへプロンプトを送信（claude のみ対応）
  fastify.post<{ Params: { agent: string; id: string }; Body: { paneId?: unknown; text?: unknown } }>(
    '/api/transcripts/:agent/:id/input',
    async (request, reply) => {
      if (request.params.agent !== PANE_CAPABLE_AGENT_TYPE) {
        return reply.status(501).send({ error: `Sending input is not supported for agent type "${request.params.agent}"` });
      }
      return handleSendInput(transcriptPaneService, request.params.id, request.body, reply);
    },
  );

  // ── 後方互換ルート（旧 UUID 直下パス、claude 固定） ──

  fastify.get<{ Params: { sessionId: string }; Querystring: { offset?: string } }>(
    '/api/transcripts/:sessionId',
    async (request, reply) => {
      const source = findSource(sources, PANE_CAPABLE_AGENT_TYPE);
      if (!source) return reply.status(404).send({ error: 'Unknown agent type' });

      const offset = parseOffset(request.query.offset);
      if (offset === 'invalid') return reply.status(400).send({ error: 'Invalid offset' });

      const result = source.readSession(request.params.sessionId, offset);
      if (!result) return reply.status(404).send({ error: 'Session not found' });
      return result;
    },
  );

  fastify.get<{ Params: { sessionId: string } }>('/api/transcripts/:sessionId/panes', async (request, reply) => {
    const result = await transcriptPaneService.listPaneCandidates(request.params.sessionId);
    if (!result) return reply.status(404).send({ error: 'Session not found' });
    return result;
  });

  fastify.post<{ Params: { sessionId: string }; Body: { paneId?: unknown; text?: unknown } }>(
    '/api/transcripts/:sessionId/input',
    async (request, reply) => handleSendInput(transcriptPaneService, request.params.sessionId, request.body, reply),
  );

  done();
};

async function handleSendInput(
  transcriptPaneService: TranscriptPaneService,
  sessionId: string,
  body: { paneId?: unknown; text?: unknown } | undefined,
  reply: FastifyReply,
) {
  const { paneId, text } = body ?? {};

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
}

export default transcriptsRoutes;
