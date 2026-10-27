import type { FastifyPluginCallback } from 'fastify';
import type { TranscriptReader } from '../modules/transcripts/sources/TranscriptSource';
import {
  AGENT_LIST_MAX_LIMIT,
  AGENT_SESSION_NOT_FOUND,
  AGENT_TRANSCRIPT_API_PREFIX,
  type AgentSessionMeta,
  type AgentSessionsResponse,
} from '../modules/transcripts/sources/agentTranscriptProtocol';

export interface AgentTranscriptRoutesOptions {
  /** このエージェントのマシン上の会話ログを読む reader 群（HOME / CLAUDE_CONFIG_DIR はこのプロセスの環境で解決される）。 */
  readers: TranscriptReader[];
}

/**
 * 後方ページングの1回あたりの読み取り予算。窓の拡張（巨大行のための最大8窓 = 最大約45MB の同期読み）を無効にし、
 * 改行を探す読み（窓1つ）と本読み（窓1つ）の最大2回、つまり reader の窓（5MB）の2倍 = 約10MB 以内に閉じ込める。
 * エージェントのイベントループ（ターミナル中継・health）を止めないため。読めないほど巨大な行は
 * ページ単位で飛ばされ、hasOlder で続きを辿れる。
 */
const BEFORE_READ_BUDGET = { maxExpandWindows: 1 } as const;

/** 非負整数のクエリ。未指定は undefined、不正値は 'invalid'。 */
function parseNonNegativeInt(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return 'invalid';
  return value;
}

/**
 * ハブ向けの会話ログ読み取り API。エージェントのトークン認証（main.ts の onRequest フック）の配下に
 * 登録すること。reader が agentType ごとに決まった場所（`~/.claude/projects` / Codex のセッション
 * ディレクトリ）だけを走査し、sessionId は reader が UUID 形式を検証してから探索するため、リクエストで
 * ファイルパスを指定する手段は無い。読み取りは offset / before による範囲指定で、reader の1回あたりの
 * 上限（5MB）を超えて返さない — 大きな JSONL を毎回全部送らない。
 */
const transcriptRoutes: FastifyPluginCallback<AgentTranscriptRoutesOptions> = (fastify, opts, done) => {
  const { readers } = opts;
  const prefix = `${AGENT_TRANSCRIPT_API_PREFIX}/:agent/sessions`;

  function findReader(agentType: string): TranscriptReader | undefined {
    return readers.find((r) => r.agentType === agentType);
  }

  fastify.get<{ Params: { agent: string }; Querystring: { limit?: string; metadata?: string } }>(prefix, async (request, reply) => {
    const reader = findReader(request.params.agent);
    if (!reader) return reply.status(404).send({ error: 'unknown_agent' });
    const limit = parseNonNegativeInt(request.query.limit);
    if (limit === 'invalid' || limit === 0) return reply.status(400).send({ error: 'Invalid limit' });
    // 件数の指定が無ければ reader の既定（50）。指定があっても AGENT_LIST_MAX_LIMIT まで。metadata=1 は preview を
    // 作らない軽量一覧（cwd 照合用。preview の走査で Codex だと1件 512KB を読むのを避ける）。
    const sessions = reader.listSessions(limit === undefined ? undefined : Math.min(limit, AGENT_LIST_MAX_LIMIT), {
      metadataOnly: request.query.metadata === '1',
    });
    const body: AgentSessionsResponse = {
      sessions: sessions.map((s) => ({ ...s, createdMs: reader.getSessionCreatedMs(s.sessionId) })),
    };
    return body;
  });

  fastify.get<{ Params: { agent: string; id: string } }>(`${prefix}/:id/meta`, async (request, reply) => {
    const reader = findReader(request.params.agent);
    if (!reader) return reply.status(404).send({ error: 'unknown_agent' });
    const cwd = reader.getSessionCwd(request.params.id);
    if (!cwd) return reply.status(404).send({ error: AGENT_SESSION_NOT_FOUND });
    const body: AgentSessionMeta = {
      cwd: cwd.cwd,
      mtimeMs: reader.getSessionMtimeMs(request.params.id),
      createdMs: reader.getSessionCreatedMs(request.params.id),
    };
    return body;
  });

  // 窓の復帰が「会話ファイルがあるか」を確かめる口。reader が探索の失敗を投げるので、500 になる（ハブは「無い」と扱わない）。
  fastify.get<{ Params: { agent: string; id: string } }>(`${prefix}/:id/exists`, async (request, reply) => {
    const reader = findReader(request.params.agent);
    if (!reader?.sessionExists) return reply.status(404).send({ error: 'unknown_agent' });
    if (!reader.sessionExists(request.params.id)) return reply.status(404).send({ error: AGENT_SESSION_NOT_FOUND });
    const body: { exists: true } = { exists: true };
    return body;
  });

  fastify.get<{ Params: { agent: string; id: string }; Querystring: { offset?: string; before?: string } }>(
    `${prefix}/:id/entries`,
    async (request, reply) => {
      const reader = findReader(request.params.agent);
      if (!reader) return reply.status(404).send({ error: 'unknown_agent' });
      const { offset: offsetRaw, before: beforeRaw } = request.query;
      if (offsetRaw !== undefined && beforeRaw !== undefined) {
        return reply.status(400).send({ error: 'Cannot specify both offset and before' });
      }
      if (beforeRaw !== undefined) {
        const before = parseNonNegativeInt(beforeRaw);
        if (before === 'invalid' || before === undefined) return reply.status(400).send({ error: 'Invalid before' });
        const result = reader.readSessionBefore(request.params.id, before, BEFORE_READ_BUDGET);
        if (!result) return reply.status(404).send({ error: AGENT_SESSION_NOT_FOUND });
        return result;
      }
      const offset = parseNonNegativeInt(offsetRaw);
      if (offset === 'invalid') return reply.status(400).send({ error: 'Invalid offset' });
      const result = reader.readSession(request.params.id, offset);
      if (!result) return reply.status(404).send({ error: AGENT_SESSION_NOT_FOUND });
      return result;
    },
  );

  fastify.get<{ Params: { agent: string; id: string } }>(`${prefix}/:id/tail`, async (request, reply) => {
    const reader = findReader(request.params.agent);
    if (!reader) return reply.status(404).send({ error: 'unknown_agent' });
    if (!reader.getSessionCwd(request.params.id)) return reply.status(404).send({ error: AGENT_SESSION_NOT_FOUND });
    return reader.getSessionTailState(request.params.id);
  });

  done();
};

export default transcriptRoutes;
