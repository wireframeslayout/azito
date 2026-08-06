import type { Window } from '../pages/workspace/types';
import type { BrowserGroupInfo } from '../hooks/useBrowserGroups';
import { buildWindowTaskMap, lookupWindowTask } from './windowTask';

export interface BrowserObject {
  serverName: string;
  groupId: string;
  pageCount: number;
  primaryUrl: string | null;
}

export interface ObjectSections {
  windows: Window[];
  operationWindows: Window[];
  browsers: BrowserObject[];
  totalCount: number;
}

export function buildObjectSections(
  windows: Window[],
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number }>,
  browserGroups: Record<string, BrowserGroupInfo[]>,
  projectServerNames: string[],
): ObjectSections {
  const taskMap = buildWindowTaskMap(taskWindows);
  const resolved = windows.map((w) =>
    w.taskId != null ? w : { ...w, taskId: lookupWindowTask(taskMap, w.serverName, w.tmuxTarget) },
  );

  const isOperation = (w: Window) => w.ownerType === 'task' || w.taskId != null;
  const projectWindows = resolved.filter((w) => !isOperation(w));
  const operationWindows = resolved.filter(isOperation);

  const serverSet = new Set(projectServerNames);
  const browsers: BrowserObject[] = [];
  for (const serverName of projectServerNames) {
    if (!serverSet.has(serverName)) continue;
    for (const g of browserGroups[serverName] ?? []) {
      browsers.push({
        serverName,
        groupId: g.groupId,
        pageCount: g.pageCount,
        primaryUrl: g.urls.find((u): u is string => !!u) ?? null,
      });
    }
  }

  return {
    windows: projectWindows,
    operationWindows,
    browsers,
    totalCount: projectWindows.length + operationWindows.length + browsers.length,
  };
}
