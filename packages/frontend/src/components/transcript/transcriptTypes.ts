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

export type TranscriptEntryType = 'user' | 'assistant' | 'system' | 'tool' | 'other' | 'interrupted' | 'command';

export interface TranscriptEntry {
  uuid: string;
  /**
   * 'interrupted' はユーザーによる中断（停止ボタン等）を表す。blocks は空 — user/assistant 発話
   * バブルではなく専用の控えめな終端行として描画する（styles/InterruptedRow.tsx）。
   * 'command' はエージェント CLI 自身のローカルスラッシュコマンド実行（例: /model）を表す。blocks は
   * コマンド出力（あれば）の text ブロック。専用の控えめな行として描画する（styles/CommandRow.tsx）。
   * 現状 Claude のみが生成する（サーバー側 TranscriptSource のドキュメント参照）。
   */
  type: TranscriptEntryType;
  timestamp: string | null;
  blocks: TranscriptBlock[];
  /** type === 'command' のときのみ設定。コマンド名（例: "/model"）。引数があれば "name args" の形。 */
  commandName?: string;
  /** type === 'assistant' のときのみ設定され得る。このターンで使われたモデル名（取得できない場合は省略）。 */
  model?: string;
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

// GET /api/transcripts/resolve-window のレスポンス型（Issue #69 Phase E-1/E-2、仕様調整3で
// best-effort フィールドを追加）。サーバー側の型
// （packages/server/src/modules/transcripts/WindowSessionResolver.ts）とフィールドを一致させる。
export type ResolveWindowResult =
  | {
      resolved: true;
      agentType: string;
      sessionId: string;
      paneId: string;
      agentDetected: boolean;
      /** そのエージェントがローカルスラッシュコマンドをセッションログへ記録するか（実装C、PromptInputBar のヒント表示に使う）。agentType 不明時は undefined。 */
      slashCommandsVisibleInLog?: boolean;
    }
  | {
      resolved: false;
      reason: 'unsupported_server' | 'no_recent_session';
      /** セッション未解決でもウィンドウ直接入力（/transcripts/window-input）のために提供される best-effort な pane 解決結果。 */
      paneId?: string;
      agentType?: string;
      agentDetected: boolean;
      /** そのエージェントがローカルスラッシュコマンドをセッションログへ記録するか（実装C、PromptInputBar のヒント表示に使う）。agentType 不明時は undefined。 */
      slashCommandsVisibleInLog?: boolean;
    };
