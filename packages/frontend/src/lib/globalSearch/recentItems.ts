import type { SearchItem } from './searchIndex';

export function recentItems(items: SearchItem[], recentProjectIds: readonly number[]): SearchItem[] {
  const windows = items.filter(item => item.window && item.active);
  const tasks = items.filter(item => item.kind === 'task' && item.recent > 0).sort((a, b) => b.recent - a.recent).slice(0, 5);
  const projects = recentProjectIds.flatMap(id => items.filter(item => item.kind === 'project' && item.id === id));
  return [...windows, ...tasks, ...projects];
}
