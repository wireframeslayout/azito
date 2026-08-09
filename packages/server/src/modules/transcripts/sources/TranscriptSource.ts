// トランスクリプト正規化スキーマ（TranscriptEntry: text/thinking/tool_use/tool_result）と
// それを供給するソースの抽象。Claude Code / Codex など、エージェントごとの JSONL 形式の違いは
// 各 *TranscriptSource 実装（sources/ClaudeTranscriptSource.ts, sources/CodexTranscriptSource.ts）
// に閉じ込め、routes/フロントはこのスキーマだけを見る。

export interface SessionSummary {
  sessionId: string;
  /** このセッションを供給したソースの agentType（'claude' | 'codex' など）。 */
  agentType: string;
  projectDir: string;
  /** JSONL 行の cwd フィールドから拾った実パス。見つからなければ null（projectDir はエンコード済みで復元不能なため）。 */
  cwd: string | null;
  mtimeMs: number;
  sizeBytes: number;
  preview: string;
}

export type TranscriptBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; name: string; input: string; truncated: boolean }
  | { kind: 'tool_result'; text: string; truncated: boolean; isError?: boolean };

export type TranscriptEntryType = 'user' | 'assistant' | 'system' | 'tool' | 'other';

export interface TranscriptEntry {
  uuid: string;
  type: TranscriptEntryType;
  timestamp: string | null;
  blocks: TranscriptBlock[];
}

export interface ReadSessionResult {
  entries: TranscriptEntry[];
  nextOffset: number;
  truncated: boolean;
}

/**
 * 1エージェント種別分のトランスクリプト読み取りを提供するアダプタ。
 * 実装はファイル走査・行パースの詳細を持つが、返す値は上記の正規化スキーマに従う。
 */
export interface TranscriptSource {
  readonly agentType: string;
  listSessions(limit?: number): SessionSummary[];
  readSession(sessionId: string, offset?: number): ReadSessionResult | null;
  getSessionCwd(sessionId: string): { cwd: string | null } | null;
}
