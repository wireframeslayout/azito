// A window's tmuxTarget may itself carry a pane suffix — the server stores task windows
// as `session:window.1` (see ExecuteTaskUseCase) — while pane clicks produce
// `session:window.<paneIndex>` for any pane (see WindowPaneTree). So compare against the
// pane-suffix-stripped base target rather than requiring an exact match.

// tmuxTarget末尾の「.数字」(pane index)のみを除去する。window名自体にドットが含まれる
// ケース（例: "session:my.window"）を壊さないよう、ドット以降が数字の場合のみ対象にする。
const PANE_SUFFIX_RE = /\.\d+$/;

export function stripPaneSuffix(target: string): string {
  return target.replace(PANE_SUFFIX_RE, '');
}

export function isSameWindowTarget(a: string, b: string): boolean {
  return stripPaneSuffix(a) === stripPaneSuffix(b);
}

/**
 * 稼働検知の照合はすべてこの1つの lookup を通す（Issue #338）。
 *
 * 稼働ソース（AgentActivityMonitor 等）が配信する `target` はペインサフィックス除去済みだが、
 * 呼び出し側が持つのは windows テーブルの `tmuxTarget`（タスクウィンドウは `session:win.1` の形で
 * 保存される）で、`serverName::target` の完全一致では引けない。以前は分類用の照合だけが正規化
 * 済みで、行インジケータと finished の照合が生キー完全一致だったため、`.1` 付きウィンドウ行だけ
 * 稼働スピナー・完了表示が出ないというズレが起きていた。
 */
export function findByWindowTarget<T extends { serverName: string; target: string }>(
  items: Iterable<T>,
  serverName: string,
  target: string,
): T | undefined {
  const normalized = stripPaneSuffix(target);
  for (const item of items) {
    if (item.serverName === serverName && stripPaneSuffix(item.target) === normalized) return item;
  }
  return undefined;
}
