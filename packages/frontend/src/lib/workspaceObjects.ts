import type { Window } from '../pages/workspace/types';
import type { BrowserGroupInfo } from '../hooks/useBrowserGroups';
import { buildWindowTaskMap, lookupWindowTask } from './windowTask';
import { windowKey } from '@azito/shared';

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

/**
 * serverName + pane-suffix-stripped tmuxTarget の物理ウィンドウキー。
 * taskId を含まないため、「同じ物理ウィンドウかどうか」の判定（isOperation 分類）専用。
 * 重複排除（別タスクが同じ物理ウィンドウを持つケースを潰さない）には使わないこと。
 */
function windowPhysicalKey(w: Window): string {
  return windowKey(w.serverName, w.tmuxTarget);
}

/**
 * オペレーション行の重複排除キー。物理ウィンドウ（serverName + pane-suffix-stripped tmuxTarget）に
 * taskId を含める。project 側ミラー行とタスク由来行は「同じタスクに解決される場合にのみ」重複とみなす。
 * taskId が異なる（あるいは片方が未解決）行は別々の物理ウィンドウ登録として扱い、潰さずそれぞれ出す。
 */
function windowDedupeKey(w: Window): string {
  return `${windowPhysicalKey(w)}/${w.taskId ?? 'none'}`;
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
  const taskOwnedPhysicalKeys = new Set(taskOwnedWindows.map(windowPhysicalKey));
  const isOperation = (w: Window) => w.ownerType === 'task' || w.taskId != null || taskOwnedPhysicalKeys.has(windowPhysicalKey(w));
  const projectWindows = resolved.filter((w) => !isOperation(w));
  const operationFromProject = resolved.filter(isOperation);

  // 同じ窓が project 側（taskWindows で解決されたもの）と taskOwnedWindows の両方から来ることがあるため、
  // server+target+taskId で重複排除する。taskId まで一致した場合のみ同一行とみなし、taskOwnedWindows は
  // 完全なウィンドウ実体（workerType/agentSessionId等）を持つので重複時はそちらを優先する。
  // taskWindows API/リポジトリに一意制約は無く、別々のタスクが同じ物理ウィンドウ（server+target）を
  // 持ちうる（実装確認済み: windows テーブルの一意インデックスは owner_type='project' のみが対象）。
  // taskId が異なる／片方が未解決の場合は別行として残し、タスク帰属を黙って上書きしない。
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
