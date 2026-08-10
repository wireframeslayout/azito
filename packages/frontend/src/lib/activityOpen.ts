import { selectTaskTerminal } from '../components/workspace/TaskPanel';

/**
 * 稼働中/最近完了ウィンドウの行を開く共通ロジック（Issue #69 T2）。
 * HomeFeed の稼働中カード・FloatingActivityPill のポップオーバー行が同じ判定を使う:
 * タスクに紐づく行は該当タスクのターミナルへ（selectTaskTerminal でウィンドウを固定してからタブを開く）、
 * タスクに紐づかない手動起動ペインはそのままペイン接続する。
 */
export interface ActivityOpenTarget {
  taskId?: number;
  serverName: string;
  target: string;
  projectId?: number;
}

export function openActivityTarget(
  entry: ActivityOpenTarget,
  title: string,
  openTask: (taskId: number, title: string, projectId?: number) => void,
  connectPane: (serverName: string, target: string, projectId?: number) => void,
): void {
  if (entry.taskId != null) {
    selectTaskTerminal(entry.taskId, { serverName: entry.serverName, target: entry.target });
    openTask(entry.taskId, title, entry.projectId);
  } else {
    connectPane(entry.serverName, entry.target, entry.projectId);
  }
}
