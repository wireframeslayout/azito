import type { ProjectListItem, Task, Window, WindowLinkView } from '../pages/workspace/types';

export type LinkedStatus = 'attention' | 'running' | 'completed';
export type LinkedFilter = 'all' | LinkedStatus;
export interface LinkedWindow {
  link: WindowLinkView;
  window: Window | null;
  task: Task | null;
  status: LinkedStatus;
  groupKey: string;
  groupLabel: string;
}
export interface LinkedGroup { key: string; label: string; items: LinkedWindow[] }

const rank: Record<LinkedStatus, number> = { attention: 0, running: 1, completed: 2 };

export function resolveLinkedWindows(links: WindowLinkView[], windows: Window[], tasks: Task[], projects: ProjectListItem[], classify: (link: WindowLinkView, window: Window | null, task: Task | null) => LinkedStatus): LinkedWindow[] {
  return links.filter(link => link.kind === 'orchestration' && link.unlinkedAt === null).map(link => {
    const task = tasks.find(item => item.id === link.taskId) ?? null;
    const window = windows.find(item => item.id === link.resolvedWindowId) ?? (task ? windows.find(item => item.taskId === task.id && item.isPrimary) : undefined) ?? null;
    const projectId = task?.projectId ?? window?.projectId;
    const project = projects.find(item => item.id === projectId);
    const serverName = window?.serverName ?? task?.serverName;
    return { link, window, task, status: classify(link, window, task), groupKey: project ? `project:${project.id}` : `server:${serverName ?? ''}`, groupLabel: project?.name ?? serverName ?? '' };
  });
}

export function groupLinkedWindows(items: LinkedWindow[], filter: LinkedFilter): LinkedGroup[] {
  const groups = new Map<string, LinkedGroup>();
  for (const item of items) {
    if (filter !== 'all' && item.status !== filter) continue;
    const group = groups.get(item.groupKey) ?? { key: item.groupKey, label: item.groupLabel, items: [] };
    group.items.push(item);
    groups.set(item.groupKey, group);
  }
  const compare = (a: LinkedWindow, b: LinkedWindow): number => rank[a.status] - rank[b.status] || (b.link.lastInteractionAt ?? '').localeCompare(a.link.lastInteractionAt ?? '') || a.link.id - b.link.id;
  for (const group of groups.values()) group.items.sort(compare);
  return [...groups.values()].sort((a, b) => rank[a.items[0].status] - rank[b.items[0].status] || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}
