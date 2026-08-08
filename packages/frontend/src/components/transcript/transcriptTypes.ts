// GET /api/transcripts, GET /api/transcripts/:sessionId のレスポンス型。
// サーバー側の型（packages/server/src/modules/transcripts/TranscriptService.ts）とフィールドを一致させる。

export interface SessionSummary {
  sessionId: string;
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

export type TranscriptEntryType = 'user' | 'assistant' | 'system' | 'other';

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

export interface TranscriptErrorResponse {
  error: string;
}
