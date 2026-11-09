import { expect, it } from 'vitest';
import { groupLinkedWindows, resolveLinkedWindows } from './linkedWindowsModel';
import type { Task, Window, WindowLinkView } from '../pages/workspace/types';

it('resolves task primary windows and orders groups by injected status and interaction', () => {
  const link = (id: number, taskId: number, lastInteractionAt: string): WindowLinkView => ({ id, taskId, lastInteractionAt, sourceWindowId: 9, targetWindowId: null, kind: 'orchestration', source: 'manual', createdAt: '', unlinkedAt: null, resolvedWindowId: null });
  const tasks = [{ id: 1, projectId: 1 }, { id: 2, projectId: 2 }, { id: 3, projectId: 1 }] as Task[];
  const windows = [{ id: 11, taskId: 1, isPrimary: true }] as Window[];
  const items = resolveLinkedWindows([link(1, 1, '2026-01-01'), link(2, 2, '2026-01-02'), link(3, 3, '2026-01-03')], windows, tasks, [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }], l => l.id === 2 ? 'attention' : 'running');
  expect(items[0].window?.id).toBe(11);
  expect(items[1].window).toBeNull();
  const groups = groupLinkedWindows(items, 'all');
  expect(groups.map(group => group.key)).toEqual(['project:2', 'project:1']);
  expect(groups[1].items.map(item => item.link.id)).toEqual([3, 1]);
  expect(groupLinkedWindows(items, 'attention').flatMap(group => group.items.map(item => item.link.id))).toEqual([2]);
});
