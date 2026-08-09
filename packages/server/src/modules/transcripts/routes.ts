import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { TranscriptPaneService } from './TranscriptPaneService';
import type { WindowSessionResolver } from './WindowSessionResolver';
import type { IWindowRepository } from '../windows/Window';
import { getAgentTranscriptProfile, type InterruptKey } from './sources/profiles';

export interface TranscriptsRouteOptions {
  sources: TranscriptSource[];
  transcriptPaneService: TranscriptPaneService;
  windowSessionResolver: WindowSessionResolver;
  windowRepo: IWindowRepository;
}

const PANE_ID_PATTERN = /^%\d+$/;
const INPUT_TEXT_MIN_LENGTH = 1;
const INPUT_TEXT_MAX_LENGTH = 32768;
/** pane 候補提示・入力送信は tmux ペインとの cwd 突合が前提のため、現状 Claude のみ対応。 */
const PANE_CAPABLE_AGENT_TYPE = 'claude';

function findSource(sources: TranscriptSource[], agentType: string): TranscriptSource | undefined {
  return sources.find((s) => s.agentType === agentType);
}

/** offset/before クエリを検証する。未指定は undefined、不正値は 'invalid' を返す。 */
function parseNonNegativeInt(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return 'invalid';
  return value;
}

/**
 * 単一セッション読み取りの GET ハンドラ本体。offset（差分読み・初回読み）と before（後方ページング）
 * は排他: 同時指定は 400。
 */
async function handleReadSession(source: TranscriptSource, sessionId: string, query: { offset?: string; before?: string }, reply: FastifyReply) {
  const { offset: offsetRaw, before: beforeRaw } = query;
  if (offsetRaw !== undefined && beforeRaw !== undefined) {
    return reply.status(400).send({ error: 'Cannot specify both offset and before' });
  }

  if (beforeRaw !== undefined) {
    const before = parseNonNegativeInt(beforeRaw);
    if (before === 'invalid' || before === undefined) return reply.status(400).send({ error: 'Invalid before' });
    const result = source.readSessionBefore(sessionId, before);
    if (!result) return reply.status(404).send({ error: 'Session not found' });
    return result;
  }

  const offset = parseNonNegativeInt(offsetRaw);
  if (offset === 'invalid') return reply.status(400).send({ error: 'Invalid offset' });

  const result = source.readSession(sessionId, offset);
  if (!result) return reply.status(404).send({ error: 'Session not found' });
  return result;
}

const transcriptsRoutes: FastifyPluginCallback<TranscriptsRouteOptions> = (fastify, opts, done) => {
  const { sources, transcriptPaneService, windowSessionResolver, windowRepo } = opts;

  // ── GET /api/transcripts/resolve-window ── ウィンドウからエージェント会話セッションを自動解決する
  // （Issue #69 Phase E-1）。windowId は数値検証、該当ウィンドウが存在しなければ 404。
  fastify.get<{ Querystring: { windowId?: string } }>('/api/transcripts/resolve-window', async (request, reply) => {
    const raw = request.query.windowId;
    const windowId = raw === undefined ? NaN : Number(raw);
    if (!Number.isSafeInteger(windowId) || windowId <= 0) {
      return reply.status(400).send({ error: 'Invalid windowId' });
    }

    const window = windowRepo.findById(windowId);
    if (!window) return reply.status(404).send({ error: 'Window not found' });

    return windowSessionResolver.resolve(window);
  });

  // ── GET /api/transcripts ── 全ソース横断のセッション一覧（mtime 降順）。?agent= で絞り込み可。
  fastify.get<{ Querystring: { agent?: string } }>('/api/transcripts', async (request) => {
    const { agent } = request.query;
    const targetSources = agent ? sources.filter((s) => s.agentType === agent) : sources;
    const sessions = targetSources.flatMap((s) => s.listSessions());
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { sessions };
  });

  // ── GET /api/transcripts/:agent/:id ── 単一セッションの読み取り（offset で差分読み、before で後方ページング）
  fastify.get<{ Params: { agent: string; id: string }; Querystring: { offset?: string; before?: string } }>(
    '/api/transcripts/:agent/:id',
    async (request, reply) => {
      const source = findSource(sources, request.params.agent);
      if (!source) return reply.status(404).send({ error: 'Unknown agent type' });

      return handleReadSession(source, request.params.id, request.query, reply);
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

  // ── POST /api/transcripts/:agent/:id/signal ── 実行中エージェントへ割り込み/制御キーを送出。
  // paneId 検証・pane 404 は /input と同様だが、cwd 一致を前提にしないため claude 以外（プロファイルが
  // 定義されたエージェント種別）にも許可する。新機能のためレガシー :id ルートには追加しない。
  fastify.post<{ Params: { agent: string; id: string }; Body: { paneId?: unknown; action?: unknown; key?: unknown } }>(
    '/api/transcripts/:agent/:id/signal',
    async (request, reply) => {
      const source = findSource(sources, request.params.agent);
      if (!source) return reply.status(404).send({ error: 'Unknown agent type' });
      return handleSendSignal(transcriptPaneService, source, request.params.agent, request.params.id, request.body, reply);
    },
  );

  // ── 後方互換ルート（旧 UUID 直下パス、claude 固定） ──

  fastify.get<{ Params: { sessionId: string }; Querystring: { offset?: string; before?: string } }>(
    '/api/transcripts/:sessionId',
    async (request, reply) => {
      const source = findSource(sources, PANE_CAPABLE_AGENT_TYPE);
      if (!source) return reply.status(404).send({ error: 'Unknown agent type' });

      return handleReadSession(source, request.params.sessionId, request.query, reply);
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

function isInterruptKey(value: unknown): value is InterruptKey {
  return value === 'Escape' || value === 'C-c';
}

async function handleSendSignal(
  transcriptPaneService: TranscriptPaneService,
  source: TranscriptSource,
  agentType: string,
  sessionId: string,
  body: { paneId?: unknown; action?: unknown; key?: unknown } | undefined,
  reply: FastifyReply,
) {
  const { paneId, action, key } = body ?? {};

  if (typeof paneId !== 'string' || !PANE_ID_PATTERN.test(paneId)) {
    return reply.status(400).send({ error: 'Invalid paneId' });
  }
  if (action !== 'interrupt' && action !== 'key') {
    return reply.status(400).send({ error: 'Invalid action' });
  }

  let resolvedKey: InterruptKey;
  if (action === 'interrupt') {
    const profile = getAgentTranscriptProfile(agentType);
    if (!profile) return reply.status(400).send({ error: `No transcript profile for agent type "${agentType}"` });
    resolvedKey = profile.interruptKey;
  } else {
    if (!isInterruptKey(key)) return reply.status(400).send({ error: 'Invalid key' });
    resolvedKey = key;
  }

  const result = await transcriptPaneService.sendSignal(source, sessionId, paneId, resolvedKey);
  if (result === 'session_not_found') return reply.status(404).send({ error: 'Session not found' });
  if (result === 'pane_not_found') return reply.status(404).send({ error: 'Pane not found' });
  return { ok: true };
}

export default transcriptsRoutes;
