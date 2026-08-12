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

export type TranscriptEntryType = 'user' | 'assistant' | 'system' | 'tool' | 'other' | 'interrupted' | 'command' | 'interaction';

/** interaction フィールド1件の入力表現。 */
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
 * type === 'interaction' のエントリが持つ、確定した対話イベントの正規化表現。
 * kind は閉じたユニオン。現状は 'question'（AskUserQuestion 由来の質問＋回答）のみ。将来
 * 'approval'（承認確認）等を追加する予定だが、追加時もここに列挙し閉じたユニオンを保つ。
 */
export interface TranscriptInteraction {
  kind: 'question';
  source: { origin: 'tool'; name: string };
  fields: TranscriptInteractionField[];
  answers?: TranscriptInteractionAnswer[];
}

export interface TranscriptEntry {
  uuid: string;
  /**
   * 'interrupted' はユーザーによる中断（停止ボタン等）を表す特別な種別。blocks は空（または理由
   * テキスト1件）で、フロントは通常の user/assistant 発話バブルではなく専用の控えめな終端行として
   * 描画する（liveStatus の判定でも「応答完了」と同様に扱い、カウントアップを止める）。
   * 'command' はエージェント CLI 自身のローカルスラッシュコマンド実行（例: /model）を表す。blocks には
   * コマンド出力（stdout/stderr、ANSI エスケープ除去済み）を text ブロックとして持たせる（出力なしなら
   * 空配列）。commandName が設定されていればコマンド行として、無ければ単独の出力のみとして描画する
   * （フロントは通常の user/assistant 発話バブルではなく専用のコマンド行として描画する）。command
   * エントリは、ローカルコマンド実行をセッション JSONL に記録するエージェント種別（現状 Claude Code）
   * のみが生成する — CLI がそもそもログに書かないエージェント種別（例: Codex の TUI ローカルコマンド）
   * では発生しない。
   * 'interaction' はエージェントとユーザーの構造化された対話イベント（現状は AskUserQuestion の
   * 質問＋回答）を表す。blocks は空、`interaction` フィールドに正規化データを持つ。transcript 層は
   * 確定した事実のみを扱う方針のため、質問がオープン中（未回答）の状態は生成しない — Claude Code は
   * 回答確定後にまとめて tool_use + tool_result を JSONL へ書き込む（質問オープン中は何も書かれない、
   * 実データで確認）。生成元の tool_use/tool_result は汎用の 'tool' 種別としては表示せず、この
   * 'interaction' エントリに置き換える。
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
   * 「バックグラウンドタスク: {{summary}}」の専用文言で描画する。
   */
  systemKind?: 'task_notification';
}

export interface ReadSessionResult {
  entries: TranscriptEntry[];
  nextOffset: number;
  truncated: boolean;
  /** 返却範囲の先頭バイト位置。上方向ページング（readSessionBefore の before）に渡す境界値。 */
  startOffset: number;
  /** startOffset より前にまだ読んでいないデータがあるか（上方向ページング可能か）。 */
  hasOlder: boolean;
}

export interface ReadSessionBeforeResult {
  entries: TranscriptEntry[];
  /** 返却範囲の先頭バイト位置。次の後方ページングではこの値を before に渡す。 */
  prevOffset: number;
  /** prevOffset より前にまだ読んでいないデータがあるか。 */
  hasOlder: boolean;
}

/**
 * 1エージェント種別分のトランスクリプト読み取りを提供するアダプタ。
 * 実装はファイル走査・行パースの詳細を持つが、返す値は上記の正規化スキーマに従う。
 *
 * 'command' 型の TranscriptEntry（ローカルスラッシュコマンド実行）は、CLI 自身がその実行を
 * セッション JSONL に記録するエージェント種別（現状 Claude Code のみ）の実装だけが生成する。
 * ログに書かないエージェント種別（例: Codex の TUI ローカルコマンド）では発生しない —
 * このケースはフロント側の入力バー注記（sources/profiles.ts の slashCommandsVisibleInLog）で
 * 別途ユーザーへ誘導する。
 */
export interface TranscriptSource {
  readonly agentType: string;
  listSessions(limit?: number): SessionSummary[];
  readSession(sessionId: string, offset?: number): ReadSessionResult | null;
  /** before（既知の行境界バイト位置）より前を後方ページングで読む。セッション未検出は null。 */
  readSessionBefore(sessionId: string, before: number): ReadSessionBeforeResult | null;
  getSessionCwd(sessionId: string): { cwd: string | null } | null;
  /**
   * セッション JSONL の最終更新時刻（epoch ms）。WindowSessionResolver の agentDetected 判定
   * （セッション活動シグナル層）用 — 直近更新されていれば「エージェントが書き込み中」とみなせる。
   * セッションが存在しない、または stat に失敗した場合は null。
   */
  getSessionMtimeMs(sessionId: string): number | null;
  /**
   * セッションの作成時刻（epoch ms）。WindowSessionResolver の tier3（cwd 照合フォールバック、
   * Issue #338 フォロー）が「このプロセスが作ったセッション」を mtime の古さに関わらず正当に
   * 採用するために使う — 作成時刻がプロセス起動時刻の近傍なら、そのプロセスが作ったセッションと
   * 判断できる（アイドルで mtime が更新されなくなっていても誤爆ではない）。セッションが存在しない、
   * または作成時刻を取得できない場合は null（このときフォールバック採用は行わず、従来の mtime
   * ベースの判定に委ねる）。
   */
  getSessionCreatedMs(sessionId: string): number | null;
  /**
   * セッション JSONL の末尾（小さなバイト窓のみ、実装は各ソースの getSessionTailState 参照）を読み、
   * 意味のある最後のレコードを稼働状態に分類する。`WindowSessionResolver.getActivityStatus()` の
   * mtime ベース判定（直近更新されていれば working）に重ねて使う — 中断直後は中断マーカー自体が
   * JSONL に書き込まれて mtime が更新されるため、mtime だけでは「稼働中」の偽陽性が生じる
   * （Issue #338 followup）。
   *
   * - 'terminal': 最後の意味あるレコードが中断マーカー、またはエージェントの最終応答（最後のブロックが
   *   text/thinking で終わるもの）。この場合はプロセスが応答待ち/実行中ではないとみなせる。
   * - 'in_progress': 最後が user 発話・tool_use・tool_result 等（応答待ち、または実行中）。
   * - 'unknown': ファイルが読めない、セッションが存在しない、または末尾窓に意味のあるレコードが
   *   見つからない。呼び出し元は従来通り mtime のみで判定する（working 扱い）。
   *
   * 将来別のエージェント種別を追加する場合、この契約（terminal/in_progress/unknown の意味）に従って
   * 実装するだけで、getActivityStatus 側のロジック変更なしに稼働判定へ反映される。
   */
  getSessionTailState(sessionId: string): Promise<'in_progress' | 'terminal' | 'unknown'>;
}
