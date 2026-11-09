import { buildTaskWindowTree } from '../components/workspace/taskSidebarChildren';
import type { Task, Window } from '../pages/workspace/types';

/** Tabs are resolved to registered windows at the workspace boundary. */
export type MaximizeTab = { kind: 'task'; taskId: number } | { kind: 'window'; windowId: number };

export interface MaximizeWindowRow {
  kind: 'window';
  key: string;
  window: Window;
  children: MaximizeWindowRow[];
}

export interface MaximizeTaskRow {
  kind: 'task';
  key: string;
  task: Task;
  windowId: number | null;
  children: MaximizeWindowRow[];
}

export type MaximizeTreeRow = MaximizeTaskRow | MaximizeWindowRow;

export function buildOpenTabsTree(
  tabs: readonly MaximizeTab[], tasks: readonly Task[], windows: ReadonlyMap<number, Window>,
  parents: ReadonlyMap<number, number>,
): MaximizeTreeRow[] {
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const taskByWindow = new Map<number, Task>();
  for (const task of tasks) for (const window of task.windows ?? []) taskByWindow.set(window.id, task);
  const rows: MaximizeTreeRow[] = [];
  const seenTasks = new Set<number>();
  const seenWindows = new Set<number>();
  for (const tab of tabs) {
    const task = tab.kind === 'task' ? taskById.get(tab.taskId) : taskByWindow.get(tab.windowId);
    if (task) {
      if (seenTasks.has(task.id)) continue;
      seenTasks.add(task.id);
      const children = buildTaskWindowTree(task, parents).map(child => {
        seenWindows.add(child.window.id);
        const descendants = child.children.map(descendant => {
          seenWindows.add(descendant.window.id);
          return { kind: 'window' as const, key: `window:${descendant.window.id}`, window: descendant.window, children: [] };
        });
        return { kind: 'window' as const, key: `window:${child.window.id}`, window: child.window, children: descendants };
      });
      rows.push({ kind: 'task', key: `task:${task.id}`, task, windowId: task.windows?.find(window => window.isPrimary)?.id ?? null, children });
    } else if (tab.kind === 'window' && !seenWindows.has(tab.windowId)) {
      const window = windows.get(tab.windowId);
      if (!window) continue;
      seenWindows.add(window.id);
      rows.push({ kind: 'window', key: `window:${window.id}`, window, children: [] });
    }
  }
  return rows;
}

export function visibleMaximizeWindows(rows: readonly MaximizeTreeRow[], expanded: ReadonlySet<string>): number[] {
  const result: number[] = [];
  function visit(row: MaximizeTreeRow): void {
    if (row.kind === 'window') result.push(row.window.id);
    if (expanded.has(row.key)) row.children.forEach(visit);
    else if (row.kind === 'task' && row.windowId !== null) result.push(row.windowId);
  }
  rows.forEach(visit);
  return result;
}
