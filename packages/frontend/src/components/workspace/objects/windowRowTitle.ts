/**
 * オブジェクト一覧のウィンドウ行の主表示テキストを決める（純関数）。
 *
 * 主表示はペインタイトル（例: claude がペインに出す「libghostty の wasm 版導入検討」の
 * ような動的タイトル）。tmux はタイトル未設定のペインで実行コマンド名を返すため、
 * `paneTitle` がコマンド名そのものの場合は「タイトルなし」とみなす。
 *
 * 取得できないとき（オフライン・タイトル空）のフォールバックは
 * ウィンドウラベル → タスクタイトル → tmux ターゲット の順。
 */
export interface WindowRowTitleInput {
  /** 表示用ペインラベル（未設定時はコマンド名が入る。resolveWindowContextExtra 参照） */
  paneTitle?: string;
  /** ペインの実行コマンド。paneTitle がコマンド名の代替かを判別するために使う */
  paneCommand?: string;
  /** ウィンドウの登録ラベル（タスク所有ウィンドウでは内部生成ID: 例 task-231--x9oh） */
  label?: string;
  taskTitle?: string;
  tmuxTarget: string;
}

export function resolveWindowRowTitle({ paneTitle, paneCommand, label, taskTitle, tmuxTarget }: WindowRowTitleInput): string {
  const title = paneTitle?.trim();
  if (title && title !== paneCommand?.trim()) return title;
  return label?.trim() || taskTitle?.trim() || tmuxTarget;
}
