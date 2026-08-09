// GET /api/transcripts, GET /api/transcripts/:agent/:id のレスポンス型。
// サーバー側の型（packages/server/src/modules/transcripts/sources/TranscriptSource.ts）とフィールドを一致させる。

export interface SessionSummary {
  sessionId: string;
  /** このセッションを供給したソースの agentType（'claude' | 'codex' など）。 */
  agentType: string;
  projectDir: string;
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
  /** 返却範囲の先頭バイト位置。上方向ページング（?before=）に渡す境界値。 */
  startOffset: number;
  /** startOffset より前にまだ読んでいないデータがあるか（上方向ページング可能か）。 */
  hasOlder: boolean;
}

/** GET /api/transcripts/:agent/:id?before=<offset> のレスポンス型（上方向ページング）。 */
export interface ReadSessionBeforeResult {
  entries: TranscriptEntry[];
  /** 返却範囲の先頭バイト位置。次の上方向ページングではこの値を before に渡す。 */
  prevOffset: number;
  /** prevOffset より前にまだ読んでいないデータがあるか。 */
  hasOlder: boolean;
}

export interface TranscriptErrorResponse {
  error: string;
}

// GET /api/transcripts/:agent/:id/panes のレスポンス型（claude のみ対応）。
// サーバー側の型（packages/server/src/modules/transcripts/TranscriptPaneService.ts）とフィールドを一致させる。

export interface PaneCandidate {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  currentPath: string;
  currentCommand: string;
  cwdMatch: boolean;
}

export interface PaneCandidatesResult {
  cwd: string | null;
  panes: PaneCandidate[];
}
