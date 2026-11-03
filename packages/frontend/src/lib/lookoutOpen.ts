import type { LookoutItem } from './lookoutSummary';
import { openActivityTarget } from './activityOpen';
import type { TerminalOpenTarget } from './terminalTargetOpen';

export function openLookoutItem(item: LookoutItem, openTask: (id: number, title: string, projectId?: number) => void, openTerminal: (target: TerminalOpenTarget, projectId?: number) => void): void {
  const row = item.primaryRow;
  if (row) {
    openActivityTarget({ taskId: item.task?.id ?? row.taskId, windowId: row.windowId, serverName: row.serverName, target: row.target, projectId: item.projectId }, item.title, openTask, openTerminal);
  } else if (item.task) {
    openTask(item.task.id, item.title, item.projectId);
  }
}
