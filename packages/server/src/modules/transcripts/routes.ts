import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import type { TranscriptSource } from './sources/TranscriptSource';
import type { TranscriptPaneService } from './TranscriptPaneService';
import type { WindowSessionResolver } from './WindowSessionResolver';
import type { WindowInputService } from './WindowInputService';
import type { IWindowRepository } from '../windows/Window';
import type { InteractionMonitor } from '../notifications/InteractionMonitor';
import type { TranscriptEntry } from './sources/TranscriptSource';
import { getAgentTranscriptProfile, type InterruptKey } from './sources/profiles';

export interface TranscriptsRouteOptions {
  sources: TranscriptSource[];
  transcriptPaneService: TranscriptPaneService;
  windowSessionResolver: WindowSessionResolver;
  windowInputService: WindowInputService;
  windowRepo: IWindowRepository;
  interactionMonitor: InteractionMonitor;
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

/** windowId クエリを検証する。未指定は undefined、不正値（正整数でない）は 'invalid' を返す。 */
function parsePositiveInt(raw: string | undefined): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return 'invalid';
  return value;
}

/**
 * `entries` を末尾から走査し、timestamp を持つ最初のエントリの epoch ms を返す。timestamp なしの
 * エントリ（null）や不正な日時文字列は「新着の証拠なし」として無視し、次(=より古い方)を見る —
 * 欠落を新着とみなさない。全件 timestamp なしなら undefined。
 */
function findLastEntryTimestampMs(entries: TranscriptEntry[]): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i].timestamp;
    if (!raw) continue;
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * 単一セッション読み取りの GET ハンドラ本体。offset（差分読み・初回読み）と before（後方ページング）
 * は排他: 同時指定は 400。
 *
 * windowId（任意）が渡された場合のみ `pendingInteraction` を応答に含める（Phase B
 * リアルタイム未回答検出）。
 *
 * clear 判定（Bug 2 修正）: offset 指定の有無に関わらず、応答に含まれる最後の timestamp 付きエントリが
 * pending シグナルの openedAt より新しければ authoritative に clear する — 「トランスクリプトへの
 * 新着到達」が close 条件の一つ（InteractionMonitor のクラスコメント参照）。offset 省略の初回読み込み
 * （全履歴）でも、既に回答済みの古い pending シグナルが残っているケースを拾えるようにするため、offset
 * の有無では判定を分岐しない。
 *
 * pendingInteraction 判定（Bug 1 修正）: Notification hook の 'open' シグナルは通常アイドル後にも
 * 発火するノイズを含むため、`InteractionMonitor.isPending()` 単体では「本当に応答待ちか」を判別
 * できない。isPending が true の場合のみ（tailState 読み取りは小さくないコストがあるため無条件には
 * 読まない）`source.getSessionTailState()` を追加で確認し、'in_progress'（トランスクリプト末尾がまだ
 * 回答を含まない = 本当に質問オープン中）の場合だけ pendingInteraction を true にする。
 *
 * interactionSignal:'none' の早期スキップ（Minor 3 修正）: windowId が渡された場合でも、その
 * ウィンドウの workerType が interactionSignal:'none'（例: codex）なプロファイルに解決される場合は
 * InteractionMonitor への問い合わせ自体を行わない（pendingInteraction は false のまま）。'none' な
 * エージェントは Notification hook 自体を持たず理論上シグナルが存在し得ないため、以降の openedAt
 * 比較・clear・isPending 呼び出しはすべて意味を持たない。ウィンドウが見つからない場合は判定材料が
 * ないため、この早期スキップは行わず既存の isPending 経由の判定（内部で存在チェック済み）に委ねる。
 */
async function handleReadSession(
  source: TranscriptSource,
  sessionId: string,
  query: { offset?: string; before?: string; windowId?: string },
  reply: FastifyReply,
  interactionMonitor: InteractionMonitor,
  windowRepo: IWindowRepository,
) {
  const { offset: offsetRaw, before: beforeRaw, windowId: windowIdRaw } = query;
  if (offsetRaw !== undefined && beforeRaw !== undefined) {
    return reply.status(400).send({ error: 'Cannot specify both offset and before' });
  }

  const windowId = parsePositiveInt(windowIdRaw);
  if (windowId === 'invalid') return reply.status(400).send({ error: 'Invalid windowId' });

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

  if (windowId === undefined) return result;

  const window = windowRepo.findById(windowId);
  if (window?.workerType && getAgentTranscriptProfile(window.workerType)?.interactionSignal === 'none') {
    return { ...result, pendingInteraction: false };
  }

  const openedAt = interactionMonitor.getOpenedAt(windowId);
  if (openedAt !== undefined) {
    const lastEntryMs = findLastEntryTimestampMs(result.entries);
    if (lastEntryMs !== undefined && lastEntryMs > openedAt) {
      interactionMonitor.clear(windowId);
    }
  }

  let pendingInteraction = false;
  if (interactionMonitor.isPending(windowId)) {
    const tailState = await source.getSessionTailState(sessionId);
    pendingInteraction = tailState === 'in_progress';
  }
  return { ...result, pendingInteraction };
}

const transcriptsRoutes: FastifyPluginCallback<TranscriptsRouteOptions> = (fastify, opts, done) => {
  const { sources, transcriptPaneService, windowSessionResolver, windowInputService, windowRepo, interactionMonitor } = opts;

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

    const result = await windowSessionResolver.resolve(window);
    // slashCommandsVisibleInLog（Issue #338 followup、実装C）: フロントが agentType を知る唯一の
    // 経路（resolve-window 応答）にこのフラグを載せる。agentType が best-effort でも未解決な場合は
    // 判定材料が無いため付与しない（フロント側は undefined を「注記を出さない」として扱う）。
    const slashCommandsVisibleInLog = result.agentType ? getAgentTranscriptProfile(result.agentType)?.slashCommandsVisibleInLog : undefined;
    return { ...result, slashCommandsVisibleInLog };
  });

  // ── POST /api/transcripts/window-input ── ウィンドウの pane へ直接テキストを送信する
  // （Issue #69 仕様調整3）。セッション JSONL の存在を前提としないため、resolve-window が
  // resolved:false でも paneId さえ得られていれば呼べる。ウィンドウ・pane の実在のみ検証する。
  fastify.post<{ Body: { windowId?: unknown; paneId?: unknown; text?: unknown } }>('/api/transcripts/window-input', async (request, reply) => {
    const { windowId, paneId, text } = request.body ?? {};

    if (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId <= 0) {
      return reply.status(400).send({ error: 'Invalid windowId' });
    }
    if (typeof paneId !== 'string' || !PANE_ID_PATTERN.test(paneId)) {
      return reply.status(400).send({ error: 'Invalid paneId' });
    }
    if (typeof text !== 'string' || text.length < INPUT_TEXT_MIN_LENGTH || text.length > INPUT_TEXT_MAX_LENGTH) {
      return reply.status(400).send({ error: 'Invalid text' });
    }

    const result = await windowInputService.sendInput(windowId, paneId, text);
    if (result === 'window_not_found') return reply.status(404).send({ error: 'Window not found' });
    if (result === 'pane_not_found') return reply.status(404).send({ error: 'Pane not found' });
    return { ok: true };
  });

  // ── POST /api/transcripts/window-signal ── ウィンドウの pane へ制御キーを送出する
  // （Issue #69 仕様調整3）。interruptKey の解決は WindowInputService 側（workerType プロファイル、
  // 未対応時は 'C-c' 既定）。
  fastify.post<{ Body: { windowId?: unknown; paneId?: unknown; action?: unknown; key?: unknown } }>(
    '/api/transcripts/window-signal',
    async (request, reply) => {
      const { windowId, paneId, action, key } = request.body ?? {};

      if (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId <= 0) {
        return reply.status(400).send({ error: 'Invalid windowId' });
      }
      if (typeof paneId !== 'string' || !PANE_ID_PATTERN.test(paneId)) {
        return reply.status(400).send({ error: 'Invalid paneId' });
      }
      if (action !== 'interrupt' && action !== 'key') {
        return reply.status(400).send({ error: 'Invalid action' });
      }

      let resolvedKey: InterruptKey | undefined;
      if (action === 'key') {
        if (!isInterruptKey(key)) return reply.status(400).send({ error: 'Invalid key' });
        resolvedKey = key;
      }

      const result = await windowInputService.sendSignal(windowId, paneId, action, resolvedKey);
      if (result === 'window_not_found') return reply.status(404).send({ error: 'Window not found' });
      if (result === 'pane_not_found') return reply.status(404).send({ error: 'Pane not found' });
      return { ok: true };
    },
  );

  // ── GET /api/transcripts ── 全ソース横断のセッション一覧（mtime 降順）。?agent= で絞り込み可。
  fastify.get<{ Querystring: { agent?: string } }>('/api/transcripts', async (request) => {
    const { agent } = request.query;
    const targetSources = agent ? sources.filter((s) => s.agentType === agent) : sources;
    const sessions = targetSources.flatMap((s) => s.listSessions());
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { sessions };
  });

  // ── GET /api/transcripts/:agent/:id ── 単一セッションの読み取り（offset で差分読み、before で後方ページング）。
  // windowId（任意）を渡すと応答に pendingInteraction が乗る（Phase B、ConversationView の2秒ポーリングが利用）。
  fastify.get<{ Params: { agent: string; id: string }; Querystring: { offset?: string; before?: string; windowId?: string } }>(
    '/api/transcripts/:agent/:id',
    async (request, reply) => {
      const source = findSource(sources, request.params.agent);
      if (!source) return reply.status(404).send({ error: 'Unknown agent type' });

      return handleReadSession(source, request.params.id, request.query, reply, interactionMonitor, windowRepo);
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

      return handleReadSession(source, request.params.sessionId, request.query, reply, interactionMonitor, windowRepo);
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
