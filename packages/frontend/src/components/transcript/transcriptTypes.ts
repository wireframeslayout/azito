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

export type TranscriptEntryType = 'user' | 'assistant' | 'system' | 'tool' | 'other' | 'interrupted' | 'command' | 'interaction';

/** interaction フィールド1件の入力表現。サーバー側 TranscriptInteractionField と一致させる。 */
export interface TranscriptInteractionField {
  id: string;
  label: string;
  input: 'select' | 'multiselect' | 'text';
  options?: { value: string; label: string; description?: string }[];
}

export interface TranscriptInteractionAnswer {
  fieldId: string;
  value: string;
}

/**
 * type === 'interaction' のエントリが持つ、確定した対話イベントの正規化表現。kind は閉じたユニオン。
 * 現状は 'question'（AskUserQuestion 由来の質問＋回答）のみ。将来 'approval'（承認確認）等を追加予定。
 */
export interface TranscriptInteraction {
  kind: 'question';
  source: { origin: 'tool'; name: string };
  fields: TranscriptInteractionField[];
  /**
   * 決着の仕方。'answered' は選択肢または自由記述で回答が確定（answers を伴う）。'declined' は選択肢を
   * 使わずに決着した状態（チャットで明確化を求めた・Esc でキャンセル）で answers を持たない。
   * 省略時は 'answered' 相当として扱う（後方互換）。サーバー側 TranscriptInteraction と一致させる。
   */
  outcome?: 'answered' | 'declined';
  answers?: TranscriptInteractionAnswer[];
}

export interface TranscriptEntry {
  uuid: string;
  /**
   * 'interrupted' はユーザーによる中断（停止ボタン等）を表す。blocks は空 — user/assistant 発話
   * バブルではなく専用の控えめな終端行として描画する（styles/InterruptedRow.tsx）。
   * 'command' はエージェント CLI 自身のローカルスラッシュコマンド実行（例: /model）を表す。blocks は
   * コマンド出力（あれば）の text ブロック。専用の控えめな行として描画する（styles/CommandRow.tsx）。
   * 現状 Claude のみが生成する（サーバー側 TranscriptSource のドキュメント参照）。
   * 'interaction' はエージェントとユーザーの構造化された対話イベント（現状は AskUserQuestion の
   * 質問＋回答）を表す。blocks は空、`interaction` フィールドに正規化データを持つ。専用のカードとして
   * 描画する（styles/InteractionCard.tsx）。決着後にのみ生成される（質問オープン中は生成しない） —
   * 選択肢以外で決着した場合は interaction.outcome === 'declined' となる。
   */
  type: TranscriptEntryType;
  timestamp: string | null;
  blocks: TranscriptBlock[];
  /** type === 'command' のときのみ設定。コマンド名（例: "/model"）。引数があれば "name args" の形。 */
  commandName?: string;
  /** type === 'assistant' のときのみ設定され得る。このターンで使われたモデル名（取得できない場合は省略）。 */
  model?: string;
  /** type === 'interaction' のときのみ設定。 */
  interaction?: TranscriptInteraction;
  /**
   * type === 'system' のときのみ設定され得るサブ種別。'task_notification' は `<task-notification>`
   * 生XML（バックグラウンドタスク完了通知）を整形した行を表す — blocks[0] のテキストは抽出した
   * `<summary>` の内容（無ければ空文字列）。フロントはこの値を見て通常の system 表示ではなく
   * 「バックグラウンドタスク: {{summary}}」の専用文言で描画する（styles 各ファイル参照）。
   */
  systemKind?: 'task_notification';
}

export interface ReadSessionResult {
  entries: TranscriptEntry[];
  nextOffset: number;
  truncated: boolean;
  /** 返却範囲の先頭バイト位置。上方向ページング（?before=）に渡す境界値。 */
  startOffset: number;
  /** startOffset より前にまだ読んでいないデータがあるか（上方向ページング可能か）。 */
  hasOlder: boolean;
  /** リクエストに windowId を付けた場合のみ設定。true の間、会話末尾に「回答待ち」バナーを表示する。 */
  pendingInteraction?: boolean;
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
