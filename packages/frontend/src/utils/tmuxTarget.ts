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
