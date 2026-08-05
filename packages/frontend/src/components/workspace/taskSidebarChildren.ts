import type { Task, Window } from '../../pages/workspace/types';
import type { BrowserGroupInfo } from '../../hooks/useBrowserGroups';
import { listPersistedBrowserTabIds, parseBrowserTabId } from '../task/taskPaneLayout';

export interface TaskChildWindow {
  kind: 'window';
  window: Window;
}

export interface TaskChildBrowser {
  kind: 'browser';
  serverName: string;
  groupId: string;
  pageCount?: number;
}

export type TaskChild = TaskChildWindow | TaskChildBrowser;

export function listTaskChildren(
  task: Task,
  browserGroups: Record<string, BrowserGroupInfo[]>,
): TaskChild[] {
  const children: TaskChild[] = [];

  if (task.windows) {
    const sorted = task.windows.slice().sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return (a.label || a.tmuxTarget).localeCompare(b.label || b.tmuxTarget);
    });
    for (const w of sorted) {
      children.push({ kind: 'window', window: w });
    }
  }

  const seen = new Set<string>();
  const browserTabIds = listPersistedBrowserTabIds(task.id);
  for (const tabId of browserTabIds) {
    const parsed = parseBrowserTabId(tabId);
    if (!parsed) continue;
    const groupId = parsed.pageId;
    const key = `${parsed.serverName}/${groupId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const serverGroups = browserGroups[parsed.serverName];
    const groupInfo = serverGroups?.find((g) => g.groupId === groupId);
    children.push({
      kind: 'browser',
      serverName: parsed.serverName,
      groupId,
      pageCount: groupInfo?.pageCount,
    });
  }

  return children;
}
