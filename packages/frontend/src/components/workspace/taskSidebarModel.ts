import type { Task } from '../../pages/workspace/types';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';

export type TaskGroupKey = 'running' | 'finished' | 'recent';

export interface TaskSidebarRow {
  task: Task;
  activity?: ActiveWindowRow;
}

export interface TaskSidebarGroup {
  key: TaskGroupKey;
  rows: TaskSidebarRow[];
}

export const RECENT_LIMIT = 10;

export function taskTimestamp(task: Task): number {
  const raw = task.updatedAt || task.createdAt;
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

// 「最近」の並べ替え基準: タスクを開いた時刻があればそれと taskTimestamp の新しい方を使う。
// 開いたことのないタスクは openedAt が無いので従来どおり taskTimestamp のみで並ぶ。
function recentSortTimestamp(task: Task, openedAt: Record<number, number>): number {
  return Math.max(openedAt[task.id] ?? 0, taskTimestamp(task));
}

export function matchesQuery(task: Task, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const idStr = String(task.id);
  const hashId = `#${idStr}`;
  if (idStr.includes(q) || hashId.includes(q)) return true;
  return [task.title, task.branch, task.worktreeBranch, task.sourceRef].some(
    (v) => typeof v === 'string' && v.toLowerCase().includes(q),
  );
}

export function buildTaskSidebarGroups(
  tasks: Task[],
  activityRows: ActiveWindowRow[],
  query: string,
  openedAt: Record<number, number> = {},
): TaskSidebarGroup[] {
  const q = query.trim();
  const filtered = q ? tasks.filter((t) => matchesQuery(t, q)) : tasks;

  if (q) {
    const rows: TaskSidebarRow[] = filtered
      .slice()
      .sort((a, b) => {
        if (a.status === 'archived' && b.status !== 'archived') return 1;
        if (a.status !== 'archived' && b.status === 'archived') return -1;
        return taskTimestamp(b) - taskTimestamp(a);
      })
      .map((task) => {
        const activity = activityRows.find((r) => r.taskId === task.id);
        return { task, activity };
      });
    return rows.length > 0 ? [{ key: 'recent', rows }] : [];
  }

  const activityByTaskId = new Map<number, ActiveWindowRow>();
  for (const row of activityRows) {
    if (row.taskId != null && !activityByTaskId.has(row.taskId)) {
      activityByTaskId.set(row.taskId, row);
    }
  }

  const assigned = new Set<number>();
  const running: TaskSidebarRow[] = [];
  const finished: TaskSidebarRow[] = [];
  const recent: TaskSidebarRow[] = [];

  for (const task of filtered) {
    if (task.status === 'archived') continue;
    const activity = activityByTaskId.get(task.id);
    if (activity?.status === 'running') {
      running.push({ task, activity });
      assigned.add(task.id);
    }
  }

  for (const task of filtered) {
    if (assigned.has(task.id) || task.status === 'archived') continue;
    const activity = activityByTaskId.get(task.id);
    if (activity?.status === 'finished') {
      finished.push({ task, activity });
      assigned.add(task.id);
    }
  }

  finished.sort((a, b) => (b.activity?.finishedAt ?? 0) - (a.activity?.finishedAt ?? 0));

  const remainingTasks = filtered
    .filter((t) => !assigned.has(t.id) && t.status !== 'archived')
    .slice()
    .sort((a, b) => recentSortTimestamp(b, openedAt) - recentSortTimestamp(a, openedAt))
    .slice(0, RECENT_LIMIT);

  for (const task of remainingTasks) {
    recent.push({ task });
  }

  const groups: TaskSidebarGroup[] = [];
  if (running.length > 0) groups.push({ key: 'running', rows: running });
  if (finished.length > 0) groups.push({ key: 'finished', rows: finished });
  if (recent.length > 0) groups.push({ key: 'recent', rows: recent });

  return groups;
}
