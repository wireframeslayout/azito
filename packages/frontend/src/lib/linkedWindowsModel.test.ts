import { expect, it } from 'vitest';
import { groupLinkedWindows, resolveLinkedWindows } from './linkedWindowsModel';
import type { Task, Window, WindowLinkView } from '../pages/workspace/types';

it('resolves task primary windows and orders groups by injected status and interaction', () => {
  const link = (id: number, taskId: number, lastInteractionAt: string): WindowLinkView => ({ id, taskId, lastInteractionAt, sourceWindowId: 9, targetWindowId: null, kind: 'orchestration', source: 'manual', createdAt: '', unlinkedAt: null, resolvedWindowId: null, resolvedTaskId: taskId, resolvedWindow: null });
  const tasks = [{ id: 1, projectId: 1 }, { id: 2, projectId: 2, status: 'waiting_input' }, { id: 3, projectId: 1 }] as Task[];
  const windows = [{ id: 11, taskId: 1, isPrimary: true }] as Window[];
  const items = resolveLinkedWindows([link(1, 1, '2026-01-01'), link(2, 2, '2026-01-02'), link(3, 3, '2026-01-03')], windows, tasks, [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }], new Map(), [], true, new Set());
  expect(items[0].window?.id).toBe(11);
  expect(items[1].window).toBeNull();
  const groups = groupLinkedWindows(items, 'all');
  expect(groups.map(group => group.key)).toEqual(['project:2', 'project:1']);
  expect(groups[1].items.map(item => item.link.id)).toEqual([1, 3]);
  expect(groupLinkedWindows(items, 'attention').flatMap(group => group.items.map(item => item.link.id))).toEqual([2]);
});

 it('uses the linked server window returned by the API even when absent from the catalog', () => {
  const window = { id: 8, ownerType: 'server', serverName: 'local', tmuxTarget: 's:w', sleeping: true, projectId: null, taskId: null, label: null } as WindowLinkView['resolvedWindow'];
  const link = { id: 1, sourceWindowId: 9, targetWindowId: 8, taskId: null, resolvedTaskId: null, resolvedWindowId: 8, resolvedWindow: window, kind: 'orchestration', unlinkedAt: null } as WindowLinkView;
  const [item] = resolveLinkedWindows([link], [], [], [], new Map(), [], true, new Set());
  expect(item.window).toMatchObject({ id: 8, ownerType: 'server', sleeping: true });
  expect(item.groupLabel).toBe('local');
});

it('treats tasks in review or done as completed', () => {
  const link = (id: number, taskId: number): WindowLinkView => ({ id, taskId, lastInteractionAt: null, sourceWindowId: 9, targetWindowId: null, kind: 'orchestration', source: 'manual', createdAt: '', unlinkedAt: null, resolvedWindowId: null, resolvedTaskId: taskId, resolvedWindow: null });
  const tasks = [{ id: 1, projectId: 1, status: 'review' }, { id: 2, projectId: 1, status: 'done' }, { id: 3, projectId: 1, status: 'running' }] as Task[];
  const items = resolveLinkedWindows([link(1, 1), link(2, 2), link(3, 3)], [], tasks, [], new Map(), [], true, new Set());
  expect(items.map(item => item.status)).toEqual(['completed', 'completed', 'unknown']);
});

it('prefers current catalog fields to the resolved API window', () => {
  const stale = { id: 8, serverName: 'local', tmuxTarget: 's:w', sleeping: true, label: 'Old' } as WindowLinkView['resolvedWindow'];
  const link = { id: 1, targetWindowId: 8, resolvedWindowId: 8, resolvedTaskId: null, taskId: null, resolvedWindow: stale, kind: 'orchestration', unlinkedAt: null } as WindowLinkView;
  const current = { id: 8, serverName: 'local', tmuxTarget: 's:w', sleeping: false, label: 'New' } as Window;
  expect(resolveLinkedWindows([link], [current], [], [], new Map(), [], true, new Set())[0].window).toEqual(current);
});

it('classifies mixed windows from activity, history and availability', () => {
  const windows = [1, 2, 3, 4, 5].map(id => ({ id, serverName: 'local', tmuxTarget: `s:${id}` } as Window));
  const links = [1, 2, 3, 4, 5, 6].map(id => ({ id, kind: 'orchestration', unlinkedAt: null, targetWindowId: id, resolvedWindowId: id, resolvedTaskId: null, resolvedWindow: null } as WindowLinkView));
  const entries = new Map([
    ['working', { windowId: 1, serverName: 'local', target: 's:1.0', running: true, status: 'working', source: 'manual' }],
    ['blocked', { serverName: 'local', target: 's:3.1', running: true, status: 'blocked', source: 'manual' }],
  ] as const);
  const finished = [{ windowId: 4, serverName: 'local', target: 's:4', finishedAt: 1 }];
  const items = resolveLinkedWindows(links, windows, [], [], entries, finished, true, new Set([5]));
  expect(items.map(item => item.status)).toEqual(['running', 'idle', 'attention', 'completed', 'attention', 'unknown']);
  expect(groupLinkedWindows(items, 'idle').flatMap(group => group.items.map(item => item.link.id))).toEqual([2]);
  const failed = resolveLinkedWindows(links, windows, [], [], entries, [], false, new Set());
  expect(failed.map(item => item.status)).toEqual(Array(6).fill('unknown'));
});

it('treats seen completions as idle and offline windows as unknown', () => {
  const window = { id: 4, serverName: 'local', tmuxTarget: 's:4' } as Window;
  const link = { id: 4, kind: 'orchestration', unlinkedAt: null, targetWindowId: 4, resolvedWindowId: 4, resolvedTaskId: null } as WindowLinkView;
  const history = [{ windowId: 4, serverName: 'local', target: 's:4', finishedAt: 1, seenAt: 2 }];
  expect(resolveLinkedWindows([link], [window], [], [], new Map(), history, true, new Set())[0].status).toBe('idle');
  expect(resolveLinkedWindows([link], [window], [], [], new Map(), [], true, new Set(), new Set(['local']))[0].status).toBe('unknown');
});

it('keeps task attention and completion when the snapshot is unavailable', () => {
  const tasks = [{ id: 1, status: 'failed' }, { id: 2, status: 'done' }, { id: 3, status: 'running' }] as Task[];
  const links = tasks.map(task => ({ id: task.id, kind: 'orchestration', unlinkedAt: null, targetWindowId: null, resolvedWindowId: null, resolvedTaskId: task.id } as WindowLinkView));
  const items = resolveLinkedWindows(links, [], tasks, [], new Map(), [], false, new Set());
  expect(items.map(item => item.status)).toEqual(['attention', 'completed', 'unknown']);
});
