import type { z } from 'zod';
import type {
  ListSessionsOptions,
  ReadSessionBeforeResult,
  ReadSessionResult,
  SessionSummary,
  SessionTailState,
  TranscriptSource,
} from './TranscriptSource';
import {
  AGENT_SESSION_NOT_FOUND,
  agentSessionPath,
  agentSessionsPath,
  agentSessionMetaSchema,
  agentSessionsResponseSchema,
  readSessionBeforeResultSchema,
  readSessionResultSchema,
  sessionTailStateSchema,
  type AgentSessionMeta,
} from './agentTranscriptProtocol';

/** エージェントへの GET。届かないときは AgentUnreachableError を投げる（AgentTransport の実装）。 */
export interface AgentJsonClient {
  getJson(path: string, timeoutMs?: number): Promise<{ status: number; body: unknown }>;
}

/** エージェントが会話ログ API を持たない（ハブより古い版）。エージェントの更新が必要。 */
export class TranscriptAgentOutdatedError extends Error {
  constructor(readonly serverName: string) {
    super(`Agent server "${serverName}" does not support the transcript API (update the agent)`);
    this.name = 'TranscriptAgentOutdatedError';
  }
}

/** エージェントの応答がスキーマに合わない（形が崩れている、sessionId が UUID でない等）。応答は使わない。 */
export class TranscriptAgentBadResponseError extends Error {
  constructor(readonly serverName: string, readonly path: string) {
    super(`Agent server "${serverName}" returned an invalid response for ${path}`);
    this.name = 'TranscriptAgentBadResponseError';
  }
}

/** 同一セッションに対する meta の連続取得（cwd → mtime → created）を1往復にまとめる短い有効期間。 */
const META_TTL_MS = 1500;

function isSessionNotFound(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === AGENT_SESSION_NOT_FOUND;
}

/**
 * 会話ログがエージェントサーバーにある場合の TranscriptSource。パース・探索はエージェント上の
 * TranscriptReader（ハブ自身の local と同じ実装）が行い、ここはその結果を HTTP で受け取るだけ。
 * 差分読み（offset）・後方ページング（before）はそのままエージェントに渡るため、大きな JSONL の全体は
 * 転送されない。
 */
export class AgentTranscriptSource implements TranscriptSource {
  private readonly metaCache = new Map<string, { at: number; meta: AgentSessionMeta | null }>();
  /** 直近の一覧で得た作成時刻。cwd 照合が候補ごとに HTTP を打たずに済む。 */
  private readonly createdMsBySession = new Map<string, number | null>();

  constructor(
    readonly agentType: string,
    private readonly serverName: string,
    private readonly client: AgentJsonClient,
  ) {}

  async listSessions(limit?: number, options: ListSessionsOptions = {}): Promise<SessionSummary[]> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', String(limit));
    if (options.metadataOnly) params.set('metadata', '1');
    const query = params.size > 0 ? `?${params.toString()}` : '';
    const path = `${agentSessionsPath(this.agentType)}${query}`;
    const body = await this.fetchOk(path, agentSessionsResponseSchema);
    // 要求した agentType 以外のセッションは受け付けない（ハブ側の agentType と取り違えない）。
    if (body.sessions.some((s) => s.agentType !== this.agentType)) throw new TranscriptAgentBadResponseError(this.serverName, path);
    this.createdMsBySession.clear();
    for (const { createdMs, sessionId } of body.sessions) this.createdMsBySession.set(sessionId, createdMs);
    return body.sessions.map(({ createdMs: _createdMs, ...summary }) => summary);
  }

  readSession(sessionId: string, offset?: number): Promise<ReadSessionResult | null> {
    const query = offset === undefined ? '' : `?offset=${offset}`;
    return this.fetchOrNull(`${agentSessionPath(this.agentType, sessionId, 'entries')}${query}`, readSessionResultSchema);
  }

  readSessionBefore(sessionId: string, before: number): Promise<ReadSessionBeforeResult | null> {
    return this.fetchOrNull(`${agentSessionPath(this.agentType, sessionId, 'entries')}?before=${before}`, readSessionBeforeResultSchema);
  }

  async getSessionCwd(sessionId: string): Promise<{ cwd: string | null } | null> {
    const meta = await this.getMeta(sessionId);
    return meta ? { cwd: meta.cwd } : null;
  }

  async getSessionMtimeMs(sessionId: string): Promise<number | null> {
    return (await this.getMeta(sessionId))?.mtimeMs ?? null;
  }

  async getSessionCreatedMs(sessionId: string): Promise<number | null> {
    const listed = this.createdMsBySession.get(sessionId);
    if (listed !== undefined) return listed;
    return (await this.getMeta(sessionId))?.createdMs ?? null;
  }

  async getSessionTailState(sessionId: string): Promise<SessionTailState> {
    const state = await this.fetchOrNull(agentSessionPath(this.agentType, sessionId, 'tail'), sessionTailStateSchema);
    // セッションが無い場合の契約（TranscriptReader.getSessionTailState）は 'unknown'。
    return state ?? { state: 'unknown', lastEntryTimestampMs: null };
  }

  private async getMeta(sessionId: string): Promise<AgentSessionMeta | null> {
    const cached = this.metaCache.get(sessionId);
    if (cached && Date.now() - cached.at < META_TTL_MS) return cached.meta;
    const meta = await this.fetchOrNull(agentSessionPath(this.agentType, sessionId, 'meta'), agentSessionMetaSchema);
    this.metaCache.set(sessionId, { at: Date.now(), meta });
    if (this.metaCache.size > 256) this.metaCache.delete(this.metaCache.keys().next().value as string);
    return meta;
  }

  private async fetchOk<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> {
    const { status, body } = await this.client.getJson(path);
    if (status === 404) throw new TranscriptAgentOutdatedError(this.serverName);
    if (status < 200 || status >= 300) throw new Error(`Agent ${path} failed (${status})`);
    return this.parse(path, schema, body);
  }

  /** 200 は本文、セッション不在の 404 は null。経路自体が無い 404（古いエージェント）は TranscriptAgentOutdatedError。 */
  private async fetchOrNull<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | null> {
    const { status, body } = await this.client.getJson(path);
    if (status === 404) {
      if (isSessionNotFound(body)) return null;
      throw new TranscriptAgentOutdatedError(this.serverName);
    }
    if (status < 200 || status >= 300) throw new Error(`Agent ${path} failed (${status})`);
    return this.parse(path, schema, body);
  }

  private parse<S extends z.ZodType>(path: string, schema: S, body: unknown): z.infer<S> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new TranscriptAgentBadResponseError(this.serverName, path);
    return parsed.data;
  }
}
