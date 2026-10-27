import { z } from 'zod';
import type {
  ReadSessionBeforeResult,
  ReadSessionResult,
  SessionSummary,
  SessionTailState,
} from './TranscriptSource';

// ハブ（AgentTranscriptSource）とエージェント（agent/transcriptRoutes.ts）の間の会話ログ API の取り決め。
// エージェントは自マシンの会話ログ（`~/.claude/projects`（CLAUDE_CONFIG_DIR）と Codex のセッション
// ディレクトリ）だけを、agentType と sessionId で指して返す。ファイルパスを受け取るエンドポイントは
// 持たない — 任意パスの読み取りは構造上できない。
//
// エージェントが動くホスト（隔離サーバーを含む）は信用しない前提で、ハブは応答を下のスキーマで必ずパースし、
// 許可したフィールドだけを受け取る（余分なフィールドは捨て、形が崩れた応答は TranscriptAgentBadResponseError）。

export const AGENT_TRANSCRIPT_API_PREFIX = '/api/transcripts';

/** エージェント API の1回の一覧の上限件数。reader の既定（50）に任せる場合は指定しない。 */
export const AGENT_LIST_MAX_LIMIT = 100;

export function agentSessionsPath(agentType: string): string {
  return `${AGENT_TRANSCRIPT_API_PREFIX}/${encodeURIComponent(agentType)}/sessions`;
}

export function agentSessionPath(agentType: string, sessionId: string, leaf: 'meta' | 'entries' | 'tail' | 'exists'): string {
  return `${agentSessionsPath(agentType)}/${encodeURIComponent(sessionId)}/${leaf}`;
}

/** 指定セッションが存在しないときの 404 本文の error。経路自体が無い（古いエージェント）404 と見分けるための印。 */
export const AGENT_SESSION_NOT_FOUND = 'session_not_found';

// ─── Response schemas ───

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** DB（agent_session_id）や `--resume` に入る値なので、UUID 以外は受け付けない。 */
export const sessionIdSchema = z.string().regex(SESSION_ID_PATTERN);

const offsetSchema = z.number().int().nonnegative();
const epochMsSchema = z.number().finite();

const blockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({ kind: z.literal('tool_use'), name: z.string(), input: z.string(), truncated: z.boolean() }),
  z.object({ kind: z.literal('tool_result'), text: z.string(), truncated: z.boolean(), isError: z.boolean().optional() }),
]);

const interactionSchema = z.object({
  kind: z.literal('question'),
  source: z.object({ origin: z.literal('tool'), name: z.string() }),
  fields: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      input: z.enum(['select', 'multiselect', 'text']),
      options: z.array(z.object({ value: z.string(), label: z.string(), description: z.string().optional() })).optional(),
    }),
  ),
  outcome: z.enum(['answered', 'declined']).optional(),
  answers: z.array(z.object({ fieldId: z.string(), value: z.string() })).optional(),
});

const entrySchema = z.object({
  uuid: z.string(),
  type: z.enum(['user', 'assistant', 'system', 'tool', 'other', 'interrupted', 'command', 'interaction']),
  timestamp: z.string().nullable(),
  blocks: z.array(blockSchema),
  commandName: z.string().optional(),
  model: z.string().optional(),
  interaction: interactionSchema.optional(),
  systemKind: z.literal('task_notification').optional(),
});

/** pendingInteraction / pendingQuestion はハブが InteractionMonitor から付けるもので、エージェントからは受け取らない（除かれる）。 */
export const readSessionResultSchema = z.object({
  entries: z.array(entrySchema),
  nextOffset: offsetSchema,
  truncated: z.boolean(),
  startOffset: offsetSchema,
  hasOlder: z.boolean(),
}) satisfies z.ZodType<ReadSessionResult>;

export const readSessionBeforeResultSchema = z.object({
  entries: z.array(entrySchema),
  prevOffset: offsetSchema,
  hasOlder: z.boolean(),
}) satisfies z.ZodType<ReadSessionBeforeResult>;

export const sessionTailStateSchema = z.object({
  state: z.enum(['in_progress', 'terminal_interrupted', 'terminal_local', 'terminal_final', 'unknown']),
  lastEntryTimestampMs: epochMsSchema.nullable(),
}) satisfies z.ZodType<SessionTailState>;

/** `GET .../sessions/:id/meta`。TranscriptReader の getSessionCwd / getSessionMtimeMs / getSessionCreatedMs を1往復にまとめたもの。 */
export const agentSessionMetaSchema = z.object({
  cwd: z.string().nullable(),
  mtimeMs: epochMsSchema.nullable(),
  createdMs: epochMsSchema.nullable(),
});
export type AgentSessionMeta = z.infer<typeof agentSessionMetaSchema>;

/** `GET .../sessions/:id/exists`（会話ファイルがある場合の 200）。無いときは session_not_found の 404、探索が壊れたときは 5xx。 */
export const agentSessionExistsSchema = z.object({ exists: z.literal(true) });

/** 一覧の1件。ハブの cwd 照合が候補ごとに作成時刻を引き直さずに済むよう、作成時刻を添える。 */
const agentSessionSummarySchema = z.object({
  sessionId: sessionIdSchema,
  agentType: z.string(),
  projectDir: z.string(),
  cwd: z.string().nullable(),
  mtimeMs: epochMsSchema,
  sizeBytes: z.number().finite().nonnegative(),
  preview: z.string(),
  createdMs: epochMsSchema.nullable(),
}) satisfies z.ZodType<SessionSummary & { createdMs: number | null }>;

export const agentSessionsResponseSchema = z.object({
  sessions: z.array(agentSessionSummarySchema),
});
export type AgentSessionsResponse = z.infer<typeof agentSessionsResponseSchema>;
