import type { SessionSummary } from './TranscriptSource';

// ハブ（AgentTranscriptSource）とエージェント（agent/transcriptRoutes.ts）の間の会話ログ API の取り決め。
// エージェントは自マシンの会話ログ（`~/.claude/projects`（CLAUDE_CONFIG_DIR）と Codex のセッション
// ディレクトリ）だけを、agentType と sessionId で指して返す。ファイルパスを受け取るエンドポイントは
// 持たない — 任意パスの読み取りは構造上できない。

export const AGENT_TRANSCRIPT_API_PREFIX = '/api/transcripts';

export function agentSessionsPath(agentType: string): string {
  return `${AGENT_TRANSCRIPT_API_PREFIX}/${encodeURIComponent(agentType)}/sessions`;
}

export function agentSessionPath(agentType: string, sessionId: string, leaf: 'meta' | 'entries' | 'tail'): string {
  return `${agentSessionsPath(agentType)}/${encodeURIComponent(sessionId)}/${leaf}`;
}

/** 一覧の1件。ハブの cwd 照合が候補ごとに作成時刻を引き直さずに済むよう、作成時刻を添える。 */
export interface AgentSessionSummary extends SessionSummary {
  createdMs: number | null;
}

export interface AgentSessionsResponse {
  sessions: AgentSessionSummary[];
}

/** `GET .../sessions/:id/meta`。TranscriptReader の getSessionCwd / getSessionMtimeMs / getSessionCreatedMs を1往復にまとめたもの。 */
export interface AgentSessionMeta {
  cwd: string | null;
  mtimeMs: number | null;
  createdMs: number | null;
}

/** 指定セッションが存在しないときの 404 本文の error。経路自体が無い（古いエージェント）404 と見分けるための印。 */
export const AGENT_SESSION_NOT_FOUND = 'session_not_found';
