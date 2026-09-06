import { selectTaskTerminal } from '../components/workspace/TaskPanel';
import { terminalRefFromTarget, type TerminalRef } from './terminalRef';

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
  connectPane: (refOrServerName: TerminalRef | string, targetOrProjectId?: string | number, projectId?: number) => void,
): void {
  if (entry.taskId != null) {
    selectTaskTerminal(entry.taskId, { serverName: entry.serverName, target: entry.target });
    openTask(entry.taskId, title, entry.projectId);
  } else {
    const ref: TerminalRef = entry.windowId != null
      ? { kind: 'windowId', serverName: entry.serverName, windowId: entry.windowId, pane: 1 }
      : terminalRefFromTarget(entry.serverName, entry.target);
    connectPane(ref, entry.projectId);
  }
}
