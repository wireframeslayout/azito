import { stripPaneSuffix as _strip } from '@azito/shared';

export { stripPaneSuffix, isSameWindowTarget, windowKey } from '@azito/shared';

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
  const normalized = _strip(target);
  for (const item of items) {
    if (item.serverName === serverName && _strip(item.target) === normalized) return item;
  }
  return undefined;
}
