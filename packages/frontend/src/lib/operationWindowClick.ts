/**
 * オペレーション行（`WindowPaneTree` の operationWindows）のクリック／コンテキストメニュー先を決める。
 *
 * 同じ物理 tmux ウィンドウ（serverName + tmuxTarget）を別々のタスクが持つことがあるため、
 * 「どのタスクに属する行がクリックされたか」は必ずクリックされた行の実体（`clicked`）から得る。
 * 物理ターゲット（serverName/target 文字列）から Map を引き直す実装は、後勝ちで登録された
 * 別タスクの行を返してしまい、行の取り違えを起こす（このモジュールが解決する不具合）。
 */
export interface OperationClickTarget {
  taskId?: number | null;
  serverName: string;
  tmuxTarget: string;
}

export type OperationClickDecision =
  | { kind: 'task'; taskId: number; serverName: string; target: string }
  | { kind: 'pane'; serverName: string; target: string };

/**
 * @param clicked クリックされた行そのものの WindowItem（taskId/serverName/tmuxTarget）
 * @param serverName クリックハンドラに渡された実際の対象サーバー名（ペイン展開時は clicked と同じ）
 * @param target クリックハンドラに渡された実際の対象ターゲット（ペイン展開時は clicked.tmuxTarget と異なりうる）
 */
export function resolveOperationClick(
  clicked: OperationClickTarget,
  serverName: string,
  target: string,
): OperationClickDecision {
  if (clicked.taskId != null) {
    return { kind: 'task', taskId: clicked.taskId, serverName: clicked.serverName, target: clicked.tmuxTarget };
  }
  return { kind: 'pane', serverName, target };
}
