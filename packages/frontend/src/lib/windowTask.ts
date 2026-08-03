/**
 * serverName + tmuxTarget（pane suffix許容）から taskId を解決するための共有ヘルパー。
 * 構築側（taskWindows由来）・参照側（tmux上のwindow）の両方でキーを同じ規則に正規化することで、
 * ServersSidebar/SessionTree・WindowsSidebar・ActiveWindowsSection の3系統で一貫した解決を行う。
 */

import { stripPaneSuffix } from '../utils/tmuxTarget';

function buildKey(serverName: string, target: string): string {
  return `${serverName}/${stripPaneSuffix(target)}`;
}

/** taskWindows から serverName+tmuxTarget（pane suffix許容）→ taskId を解決するMapを構築する */
export function buildWindowTaskMap(
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const w of taskWindows) {
    map.set(buildKey(w.serverName, w.tmuxTarget), w.taskId);
  }
  return map;
}

/** buildWindowTaskMap が構築したMapから serverName+target（pane suffix許容）で taskId を引く */
export function lookupWindowTask(map: Map<string, number>, serverName: string, target: string): number | undefined {
  return map.get(buildKey(serverName, target));
}
