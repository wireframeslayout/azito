import { formatWindowId, formatWindowTitleLine, resolveWindowTitle } from '@azito/shared';
import { findSessionWindow } from '../windowMatch';
import { RUNNING_STATUSES } from '../../components/task/StatusDropdown';
import type { ProjectListItem, Session, Task, Window } from '../../pages/workspace/types';

export type SearchKind = 'window' | 'orchestrator' | 'task' | 'project';
export interface SearchItem {
  kind: SearchKind;
  id: number;
  title: string;
  projectId: number;
  projectName: string;
  fields: string[];
  window?: Window;
  task?: Task;
  recent: number;
  active: boolean;
}

export function normalizeSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

export function buildSearchIndex(projects: ProjectListItem[], tasks: Task[], taskOpenedAt: Record<number, number>, activeWindowIds: ReadonlySet<number>, sessions: Record<string, Session[]>): SearchItem[] {
  const items: SearchItem[] = [];
  const projectById = new Map(projects.map(project => [project.id, project]));
  const seenWindows = new Set<number>();
  const addWindow = (window: Window, project: ProjectListItem, task?: Task) => {
    if (seenWindows.has(window.id)) return;
    seenWindows.add(window.id);
    const matched = findSessionWindow(window, sessions[window.serverName] ?? []);
    const pane = matched?.window.panes.find(p => p.active) ?? matched?.window.panes[0];
    const display = resolveWindowTitle({ ...window, paneTitle: pane?.title, paneCommand: pane?.command, taskTitle: task?.title });
    const title = display.title;
    items.push({ kind: window.role === 'orchestrator' ? 'orchestrator' : 'window', id: window.id, title, projectId: project.id, projectName: project.name,
      fields: [title, formatWindowTitleLine(display), formatWindowId(window.id), `w${window.id}`, String(window.id), window.serverName, project.name, task?.title ?? '', task ? `#${task.id}` : ''],
      window, recent: task ? taskOpenedAt[task.id] ?? 0 : 0, active: activeWindowIds.has(window.id) });
  };
  for (const task of tasks) {
    const project = projectById.get(task.projectId);
    if (!project) continue;
    items.push({ kind: 'task', id: task.id, title: task.title, projectId: project.id, projectName: project.name,
      fields: [task.title, `#${task.id}`, String(task.id), project.name, task.status, task.sourceRef ?? ''], task,
      recent: taskOpenedAt[task.id] ?? 0, active: RUNNING_STATUSES.has(task.status) });
    for (const window of task.windows ?? []) addWindow(window, project, task);
  }
  for (const project of projects) {
    items.push({ kind: 'project', id: project.id, title: project.name, projectId: project.id, projectName: project.name,
      fields: [project.name], recent: 0, active: false });
    for (const window of project.windows ?? []) addWindow(window, project);
  }
  return items;
}

function score(field: string, term: string): number {
  if (field === term) return 4;
  if (field.startsWith(term)) return 3;
  if (field.split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(term))) return 2;
  return field.includes(term) ? 1 : 0;
}

export function searchIndex(items: SearchItem[], query: string): SearchItem[] {
  const normalized = normalizeSearch(query);
  const terms = normalized ? normalized.split(/\s+/u) : [];
  return items.map(item => {
    const fields = item.fields.map(normalizeSearch);
    const scores = terms.map(term => Math.max(...fields.map(field => score(field, term))));
    return { item, score: scores.length ? Math.min(...scores) : 1 };
  }).filter(result => result.score > 0).sort((a, b) => b.score - a.score || Number(b.item.active) - Number(a.item.active) || b.item.recent - a.item.recent || a.item.title.localeCompare(b.item.title) || a.item.id - b.item.id).map(result => result.item);
}
