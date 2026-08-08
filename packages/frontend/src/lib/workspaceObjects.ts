import type { Window } from '../pages/workspace/types';
import type { BrowserGroupInfo } from '../hooks/useBrowserGroups';
import { buildWindowTaskMap, lookupWindowTask } from './windowTask';
import { stripPaneSuffix } from '../utils/tmuxTarget';

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

/** serverName + pane-suffix-stripped tmuxTarget の一意キー。オペレーション行の重複排除に使う */
function windowDedupeKey(w: Window): string {
  return `${w.serverName}/${stripPaneSuffix(w.tmuxTarget)}`;
}

export function buildObjectSections(
  windows: Window[],
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number }>,
  taskOwnedWindows: Window[],
  browserGroups: Record<string, BrowserGroupInfo[]>,
  projectServerNames: string[],
): ObjectSections {
  const taskMap = buildWindowTaskMap(taskWindows);
  const resolved = windows.map((w) =>
    w.taskId != null ? w : { ...w, taskId: lookupWindowTask(taskMap, w.serverName, w.tmuxTarget) },
  );

  // タスク所有ウィンドウ（ownerType='task', project_id=NULL）は project.windows に構造上入らないため、
  // 呼び出し元がプロジェクト範囲のタスクから集めた実体を別途受け取り、ここでマージする。
  const taskOwnedKeys = new Set(taskOwnedWindows.map(windowDedupeKey));
  const isOperation = (w: Window) => w.ownerType === 'task' || w.taskId != null || taskOwnedKeys.has(windowDedupeKey(w));
  const projectWindows = resolved.filter((w) => !isOperation(w));
  const operationFromProject = resolved.filter(isOperation);

  // 同じ窓が project 側（taskWindows で解決されたもの）と taskOwnedWindows の両方から来ることがあるため、
  // server+target で重複排除する。taskOwnedWindows は完全なウィンドウ実体（workerType/agentSessionId等）を
  // 持つので、重複時はそちらを優先する。
  const operationMap = new Map<string, Window>();
  for (const w of operationFromProject) operationMap.set(windowDedupeKey(w), w);
  for (const w of taskOwnedWindows) operationMap.set(windowDedupeKey(w), w);

  // 表示順を安定させる（実行のたびに揺れないよう taskId → label → id の順でソート）
  const operationWindows = [...operationMap.values()].sort((a, b) => {
    const taskDiff = (a.taskId ?? 0) - (b.taskId ?? 0);
    if (taskDiff !== 0) return taskDiff;
    const labelDiff = (a.label ?? '').localeCompare(b.label ?? '');
    if (labelDiff !== 0) return labelDiff;
    return a.id - b.id;
  });

  const browsers: BrowserObject[] = [];
  for (const serverName of projectServerNames) {
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
