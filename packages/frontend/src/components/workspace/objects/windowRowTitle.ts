/**
 * オブジェクト一覧のウィンドウ行の表示テキスト（主表示・検索対象）を決める（純関数）。
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

/**
 * ペインの実タイトル（エージェントが設定した動的タイトル）。タイトル未設定のペインでは
 * tmux がコマンド名を返すため、その場合は「タイトルなし」として undefined を返す。
 */
export function resolvePaneDisplayTitle(paneTitle?: string, paneCommand?: string): string | undefined {
  const title = paneTitle?.trim();
  if (!title || title === paneCommand?.trim()) return undefined;
  return title;
}

export function resolveWindowRowTitle({ paneTitle, paneCommand, label, taskTitle, tmuxTarget }: WindowRowTitleInput): string {
  return resolvePaneDisplayTitle(paneTitle, paneCommand)
    ?? (label?.trim() || taskTitle?.trim() || tmuxTarget);
}

export interface WindowSearchTextInput extends WindowRowTitleInput {
  serverName: string;
  taskId?: number;
  branch?: string;
  worktreeBranch?: string;
}

/**
 * 行の検索対象テキスト（小文字化・空要素除去済み）。主表示になったペインタイトルでも
 * 検索できるよう、実ペインタイトルを含める。
 */
export function buildWindowSearchText(input: WindowSearchTextInput): string {
  const { paneTitle, paneCommand, label, tmuxTarget, serverName, taskId, taskTitle, branch, worktreeBranch } = input;
  return [
    resolvePaneDisplayTitle(paneTitle, paneCommand),
    label, tmuxTarget, serverName,
    taskId != null ? `#${taskId}` : undefined,
    taskTitle, branch, worktreeBranch,
  ].filter(Boolean).join(' ').toLowerCase();
}
