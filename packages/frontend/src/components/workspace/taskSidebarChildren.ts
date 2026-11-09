import { activeWindowTitleInput } from '../../lib/windowDisplay';
import { resolveWindowTitle, formatWindowTitleLine } from '@azito/shared';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import type { Task, Window } from '../../pages/workspace/types';
import type { BrowserGroupInfo } from '../../hooks/useBrowserGroups';
import { listPersistedBrowserTabIds, parseBrowserTabId } from '../task/taskPaneLayout';

export interface TaskChildWindow {
  kind: 'window';
  window: Window;
  children: TaskSubagentWindow[];
}

export interface TaskSubagentWindow {
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

export function buildTaskWindowTree(task: Task, parents: ReadonlyMap<number, number>): TaskChildWindow[] {
  const sorted = (task.windows ?? []).slice().sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return (a.label || a.tmuxTarget).localeCompare(b.label || b.tmuxTarget);
  });
  const primaryIds = new Set(sorted.filter(w => w.isPrimary).map(w => w.id));
  return sorted.filter(w => !parents.has(w.id) || !primaryIds.has(parents.get(w.id)!)).map(window => ({
    kind: 'window', window,
    children: window.isPrimary ? sorted.filter(w => parents.get(w.id) === window.id && !w.isPrimary).map(w => ({ kind: 'window', window: w })) : [],
  }));
}

export function listTaskChildren(
  task: Task,
  browserGroups: Record<string, BrowserGroupInfo[]>,
  parents: ReadonlyMap<number, number>,
): TaskChild[] {
  const children: TaskChild[] = [];

  children.push(...buildTaskWindowTree(task, parents));

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

export function taskChildWindowTitle(w: Window, taskTitle: string, activity?: ActiveWindowRow): string {
  return formatWindowTitleLine(resolveWindowTitle({
    ...activeWindowTitleInput({
      windowId: w.id, target: w.tmuxTarget, paneTitle: activity?.paneTitle, paneName: activity?.paneName,
      paneCommand: activity?.paneCommand, label: w.label, labelSource: w.labelSource, taskTitle,
      workerType: w.workerType, windowType: w.windowType,
    }),
  }));
}
