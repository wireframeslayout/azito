import { useMemo } from 'react';
import { resolveActivityTitle, type ActivityTitleData } from '../lib/windowDisplay';
import { useAgentActivity } from './useAgentActivity';
import { activityKey, activityKeyForEntry } from '../lib/finishedWindows';
import { sortActiveWindowRows } from '../lib/sortActiveWindowRows';

export interface ActiveWindowRow {
  title: string;
  key: string;
  serverName: string;
  target: string;
  windowId?: number;
  label?: string;
  labelSource?: 'auto' | 'user';
  taskTitle?: string;
  workerType?: string;
  windowType?: string;
  paneTitle?: string;
  paneCommand?: string;
  taskId?: number;
  projectId?: number;
  status: 'running' | 'finished';
  activityStatus?: 'working' | 'blocked';
  finishedAt?: number;
  seenAt?: number;
  paneName?: string;
}

export function useActiveWindowRows(data: ActivityTitleData) {
  const { entries, finishedEntries } = useAgentActivity();

  const rows = useMemo<ActiveWindowRow[]>(() => {
    const running: ActiveWindowRow[] = Array.from(entries.values())
      .filter((e) => e.running)
      .map((e) => ({
        title: resolveActivityTitle(e, data),
        key: activityKey(e.serverName, e.target, e.windowId),
        serverName: e.serverName,
        target: e.target,
        windowId: e.windowId,
        label: e.label,
        labelSource: e.labelSource,
        taskTitle: e.taskTitle,
        workerType: e.workerType,
        windowType: e.windowType,
        paneTitle: e.paneTitle,
        paneCommand: e.paneCommand,
        taskId: e.taskId,
        projectId: e.projectId,
        status: 'running',
        activityStatus: e.status,
        paneName: e.paneName,
      }));
    const runningKeys = new Set(running.map((r) => r.key));
    const finishedRows: ActiveWindowRow[] = finishedEntries
      .filter((e) => !runningKeys.has(activityKeyForEntry(e)))
      .map((e) => ({
        title: resolveActivityTitle(e, data),
        key: activityKeyForEntry(e),
        serverName: e.serverName,
        target: e.target,
        windowId: e.windowId,
        label: e.label,
        labelSource: e.labelSource,
        taskTitle: e.taskTitle,
        workerType: e.workerType,
        windowType: e.windowType,
        paneTitle: e.paneTitle,
        paneCommand: e.paneCommand,
        taskId: e.taskId,
        projectId: e.projectId,
        status: 'finished',
        finishedAt: e.finishedAt,
        seenAt: e.seenAt,
        paneName: e.paneName,
      }));
    return sortActiveWindowRows([...running, ...finishedRows]);
  }, [entries, finishedEntries, data]);

  const blockedCount = rows.filter((r) => r.status === 'running' && r.activityStatus === 'blocked').length;

  return { rows, blockedCount, totalCount: rows.filter((r) => r.status === 'running' || r.seenAt == null).length };
}
