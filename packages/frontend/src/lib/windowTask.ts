/**
 * serverName + tmuxTarget（pane suffix許容）から taskId を解決するための共有ヘルパー。
 * 構築側（taskWindows由来）・参照側（tmux上のwindow）の両方でキーを同じ規則に正規化することで、
 * ServersSidebar/SessionTree・WindowsSidebar・ActiveWindowsSection の3系統で一貫した解決を行う。
 */

import { windowKey } from '@azito/shared';

/** taskWindows から serverName+tmuxTarget（pane suffix許容）→ taskId を解決するMapを構築する。
 *  windowId が存在する場合は `wid:<windowId>` キーも挿入する（windowId 優先照合用）。 */
export function buildWindowTaskMap(
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number; id?: number }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const w of taskWindows) {
    map.set(windowKey(w.serverName, w.tmuxTarget), w.taskId);
    if (w.id != null) {
      map.set(`wid:${w.id}`, w.taskId);
    }
  }
  return map;
}

/** windowId で taskId を引く（windowId 優先パス） */
export function lookupWindowTaskByWindowId(map: Map<string, number>, windowId: number): number | undefined {
  return map.get(`wid:${windowId}`);
}

/** buildWindowTaskMap が構築したMapから serverName+target（pane suffix許容）で taskId を引く */
export function lookupWindowTask(map: Map<string, number>, serverName: string, target: string): number | undefined {
  return map.get(windowKey(serverName, target));
}
