import { isAttentionTarget, type AttentionContext } from './orchestrationModel';
import type { ProjectListItem, Task, Window, WindowLinkView } from '../pages/workspace/types';

export type LinkedStatus = 'attention' | 'running' | 'completed';
export type LinkedFilter = 'all' | LinkedStatus;
export interface LinkedWindow {
  link: WindowLinkView;
  window: Window | null;
  task: Task | null;
  status: LinkedStatus;
  lastActivityAt?: string;
  groupKey: string;
  groupLabel: string;
}
export interface LinkedGroup { key: string; label: string; items: LinkedWindow[] }

const rank: Record<LinkedStatus, number> = { attention: 0, running: 1, completed: 2 };

export function resolveLinkedWindows(links: WindowLinkView[], windows: Window[], tasks: Task[], projects: ProjectListItem[], context: AttentionContext): LinkedWindow[] {
  return links.filter(link => link.kind === 'orchestration' && link.unlinkedAt === null).map(link => {
    const task = tasks.find(item => item.id === link.resolvedTaskId) ?? null;
    const resolvedId = link.resolvedWindowId ?? link.targetWindowId;
    const window = windows.find(item => item.id === resolvedId) ?? (task ? windows.find(item => item.taskId === task.id && item.isPrimary) ?? task.windows?.find(item => item.isPrimary) : undefined) ?? null;
    const projectId = task?.projectId ?? window?.projectId;
    const project = projects.find(item => item.id === projectId);
    const serverName = window?.serverName ?? task?.serverName;
    return { link, window, task, status: isAttentionTarget({ windowId: link.resolvedWindowId, taskId: link.resolvedTaskId, kind: link.kind }, context) ? 'attention' : task && ['completed', 'done'].includes(task.status) ? 'completed' : 'running', groupKey: projectId != null ? `project:${projectId}` : `server:${serverName ?? ''}`, groupLabel: project?.name ?? (projectId != null ? String(projectId) : serverName ?? '') };
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
  const compare = (a: LinkedWindow, b: LinkedWindow): number => rank[a.status] - rank[b.status] || (b.link.lastInteractionAt ?? b.lastActivityAt ?? '').localeCompare(a.link.lastInteractionAt ?? a.lastActivityAt ?? '') || a.link.id - b.link.id;
  for (const group of groups.values()) group.items.sort(compare);
  return [...groups.values()].sort((a, b) => rank[a.items[0].status] - rank[b.items[0].status] || a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

const ACKNOWLEDGED_KEY = 'azito:linked-completion-acknowledgements';
export function acknowledgeLinkedCompletion(linkId: number, completedAt: string): void {
  const values = readAcknowledgements();
  localStorage.setItem(ACKNOWLEDGED_KEY, JSON.stringify({ ...values, [linkId]: completedAt }));
}
export function isLinkedCompletionAcknowledged(linkId: number, completedAt: string): boolean {
  return readAcknowledgements()[linkId] === completedAt;
}
function readAcknowledgements(): Record<string, string> {
  const raw = localStorage.getItem(ACKNOWLEDGED_KEY);
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}
