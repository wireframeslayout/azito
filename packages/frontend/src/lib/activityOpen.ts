import { selectTaskTerminal } from '../components/workspace/TaskPanel';
import type { TerminalOpenTarget } from './terminalTargetOpen';

export interface ActivityOpenTarget {
  taskId?: number;
  windowId?: number;
  serverName: string;
  target: string;
  projectId?: number;
}

export function openActivityTarget(
  entry: ActivityOpenTarget,
  title: string,
  openTask: (taskId: number, title: string, projectId?: number) => void,
  openTerminal: (req: TerminalOpenTarget, projectId?: number) => void,
): void {
  if (entry.taskId != null) {
    selectTaskTerminal(entry.taskId, { serverName: entry.serverName, target: entry.target });
    openTask(entry.taskId, title, entry.projectId);
  } else {
    openTerminal({ serverName: entry.serverName, target: entry.target, windowId: entry.windowId }, entry.projectId);
  }
}
