import { useMemo } from 'react';
import { useAgentActivity } from './useAgentActivity';
import { activityKey, activityKeyForEntry } from '../lib/finishedWindows';
import type { FinishedEntry } from '../lib/finishedWindows';

export interface ActiveWindowRow {
  key: string;
  serverName: string;
  target: string;
  windowId?: number;
  label?: string;
  taskId?: number;
  projectId?: number;
  status: 'running' | 'finished';
  activityStatus?: 'working' | 'blocked';
  finishedAt?: number;
  paneName?: string;
}

export function useActiveWindowRows() {
  const { entries, finishedEntries } = useAgentActivity();

  const rows = useMemo<ActiveWindowRow[]>(() => {
    const running: ActiveWindowRow[] = Array.from(entries.values())
      .filter((e) => e.running)
      .map((e) => ({
        key: activityKey(e.serverName, e.target, e.windowId),
        serverName: e.serverName,
        target: e.target,
        windowId: e.windowId,
        label: e.label,
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
        key: activityKeyForEntry(e),
        serverName: e.serverName,
        target: e.target,
        windowId: e.windowId,
        label: e.label,
        taskId: e.taskId,
        projectId: e.projectId,
        status: 'finished',
        finishedAt: e.finishedAt,
        paneName: e.paneName,
      }));
    return [...running, ...finishedRows];
  }, [entries, finishedEntries]);

  const blockedCount = rows.filter((r) => r.status === 'running' && r.activityStatus === 'blocked').length;

  return { rows, blockedCount, totalCount: rows.length };
}
