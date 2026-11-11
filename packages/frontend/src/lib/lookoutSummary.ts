import type { ActiveWindowRow } from '../hooks/useActiveWindowRows';
import type { Task } from '../pages/workspace/types';
import { isAttentionTask } from './orchestrationModel';
import { groupRunningRows } from './activityPillLogic';

export type LookoutStatus = 'blocked' | 'waiting_input' | 'pending_approval' | 'phase_review' | 'failed' | 'working' | 'finished';

export interface LookoutItem {
  key: string;
  title: string;
  status: LookoutStatus;
  task?: Task;
  primaryRow?: ActiveWindowRow;
  projectId?: number;
  activeWindows: number;
  totalWindows: number;
  windowNames: string[];
  hasBlocked: boolean;
}

export interface LookoutSections {
  attention: LookoutItem[];
  active: LookoutItem[];
  finished: LookoutItem[];
  counts: { attention: number; active: number; finished: number; failed: number };
}

export interface LookoutInput {
  rows: ActiveWindowRow[];
  allTasks: Task[];
  lastSeenMs: number;
  scope?: { windowIds: ReadonlySet<number> };
}

function makeItem(key: string, task: Task | undefined, rows: ActiveWindowRow[]): LookoutItem {
  const blockedRow = rows.find((row) => row.activityStatus === 'blocked');
  const primaryRow = blockedRow ?? rows[0];
  const hasBlocked = blockedRow != null;
  const status: LookoutStatus = hasBlocked ? 'blocked' : isAttentionTask(task) && task ? task.status as LookoutStatus : 'working';
  return {
    key, title: task?.title ?? primaryRow!.title, status, task, primaryRow,
    projectId: task?.projectId ?? primaryRow?.projectId,
    activeWindows: rows.length,
    totalWindows: Math.max(task?.windows?.length ?? 0, rows.length),
    windowNames: rows.map((row) => row.title), hasBlocked,
  };
}

export function buildLookoutSections({ rows, allTasks, lastSeenMs, scope }: LookoutInput): LookoutSections {
  const windowIds = scope?.windowIds;
  const scopedRows = windowIds ? rows.filter((row) => row.windowId != null && windowIds.has(row.windowId)) : rows;
  const scopedTasks = windowIds ? allTasks.filter((task) =>
    task.windows?.some((window) => windowIds.has(window.id)) || scopedRows.some((row) => row.taskId === task.id)
  ) : allTasks;
  const taskById = new Map(scopedTasks.map((task) => [task.id, task]));
  const taskByWindowId = new Map(scopedTasks.flatMap((task) => (task.windows ?? []).map((window) => [window.id, task] as const)));
  const runningRows = scopedRows.map((row) => {
    const task = row.taskId != null ? taskById.get(row.taskId)
      : row.windowId != null ? taskByWindowId.get(row.windowId) : undefined;
    return task && row.taskId == null ? { ...row, taskId: task.id } : row;
  });
  const groups = new Map<string, { task?: Task; rows: ActiveWindowRow[] }>();
  for (const group of groupRunningRows(runningRows)) {
    const taskId = group.representativeRow.taskId;
    groups.set(group.groupKey, { task: taskId != null ? taskById.get(taskId) : undefined, rows: group.rows });
  }
  for (const task of scopedTasks) {
    if (!isAttentionTask(task)) continue;
    const key = `task:${task.id}`;
    if (!groups.has(key)) groups.set(key, { task, rows: [] });
  }
  const items = Array.from(groups, ([key, group]) => makeItem(key, group.task, group.rows));
  const attention = items.filter((item) => item.status !== 'working').sort((a, b) => {
    const priority = Number(b.hasBlocked) - Number(a.hasBlocked);
    if (priority) return priority;
    const aTime = a.task ? Date.parse(a.task.updatedAt) : NaN;
    const bTime = b.task ? Date.parse(b.task.updatedAt) : NaN;
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
  const active = items.filter((item) => item.status === 'working');
  const latestFinished = new Map<string, ActiveWindowRow>();
  for (const row of scopedRows) {
    if (row.status !== 'finished' || row.finishedAt == null || row.finishedAt <= lastSeenMs) continue;
    const previous = latestFinished.get(row.key);
    if (!previous || (previous.finishedAt != null && row.finishedAt > previous.finishedAt)) latestFinished.set(row.key, row);
  }
  const finished = Array.from(latestFinished.values()).sort((a, b) => b.finishedAt! - a.finishedAt!).map((row): LookoutItem => ({
    key: `finished:${row.key}`, title: row.title, status: 'finished', primaryRow: row,
    task: row.taskId != null ? taskById.get(row.taskId) : row.windowId != null ? taskByWindowId.get(row.windowId) : undefined,
    projectId: row.projectId, activeWindows: 0, totalWindows: 1, windowNames: [row.title], hasBlocked: false,
  }));
  return { attention, active, finished, counts: {
    attention: attention.length, active: active.length, finished: finished.length,
    failed: attention.filter((item) => item.task?.status === 'failed').length,
  } };
}
