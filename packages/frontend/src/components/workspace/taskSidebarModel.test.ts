import { describe, expect, it } from 'vitest';
import type { Task } from '../../pages/workspace/types';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { buildTaskSidebarGroups, findWindowActivity, matchesQuery, RECENT_LIMIT } from './taskSidebarModel';

function makeTask(overrides: Partial<Task> & { id: number }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: '',
    status: 'open',
    projectId: 1,
    unitId: null,
    priority: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Task;
}

function makeActivity(taskId: number, status: 'running' | 'finished', extra?: Partial<ActiveWindowRow>): ActiveWindowRow {
  return {
    key: `srv/${taskId}`,
    serverName: 'srv',
    target: `task-${taskId}:0`,
    status,
    taskId,
    ...extra,
  };
}

describe('matchesQuery', () => {
  const task = makeTask({ id: 541, title: 'Fix login bug', branch: 'fix/login', sourceRef: '#42' });

  it('matches by #id', () => {
    expect(matchesQuery(task, '#541')).toBe(true);
    expect(matchesQuery(task, '#54')).toBe(true);
  });

  it('matches by numeric id', () => {
    expect(matchesQuery(task, '541')).toBe(true);
  });

  it('matches by title substring', () => {
    expect(matchesQuery(task, 'login')).toBe(true);
    expect(matchesQuery(task, 'LOGIN')).toBe(true);
  });

  it('matches by branch', () => {
    expect(matchesQuery(task, 'fix/log')).toBe(true);
  });

  it('matches by sourceRef', () => {
    expect(matchesQuery(task, '#42')).toBe(true);
  });

  it('does not match unrelated query', () => {
    expect(matchesQuery(task, 'deployment')).toBe(false);
  });

  it('returns true for empty query', () => {
    expect(matchesQuery(task, '')).toBe(true);
    expect(matchesQuery(task, '  ')).toBe(true);
  });
});

describe('findWindowActivity', () => {
  it('matches when the window target carries a pane suffix the activity target lacks', () => {
    const rows: ActiveWindowRow[] = [makeActivity(1, 'running', { serverName: 'session', target: 'session:win' })];
    const found = findWindowActivity(rows, 'session', 'session:win.1');
    expect(found).toBe(rows[0]);
  });

  it('does not match when the server name differs', () => {
    const rows: ActiveWindowRow[] = [makeActivity(1, 'running', { serverName: 'other', target: 'session:win' })];
    const found = findWindowActivity(rows, 'session', 'session:win.1');
    expect(found).toBeUndefined();
  });

  it('returns undefined when there is no matching row', () => {
    const rows: ActiveWindowRow[] = [makeActivity(1, 'running', { serverName: 'session', target: 'session:other' })];
    const found = findWindowActivity(rows, 'session', 'session:win.1');
    expect(found).toBeUndefined();
  });
});

describe('buildTaskSidebarGroups', () => {
  it('returns empty for no tasks', () => {
    expect(buildTaskSidebarGroups([], [], '')).toEqual([]);
  });

  it('same task does not appear in both running and finished', () => {
    const task = makeTask({ id: 1 });
    const rows: ActiveWindowRow[] = [
      makeActivity(1, 'running'),
      makeActivity(1, 'finished', { finishedAt: 100 }),
    ];
    const groups = buildTaskSidebarGroups([task], rows, '');
    const allTaskIds = groups.flatMap((g) => g.rows.map((r) => r.task.id));
    expect(allTaskIds).toEqual([1]);
    expect(groups[0].key).toBe('running');
  });

  it('excludes archived tasks when query is empty', () => {
    const tasks = [
      makeTask({ id: 1, status: 'archived' }),
      makeTask({ id: 2, status: 'open' }),
    ];
    const groups = buildTaskSidebarGroups(tasks, [], '');
    const allTaskIds = groups.flatMap((g) => g.rows.map((r) => r.task.id));
    expect(allTaskIds).toContain(2);
    expect(allTaskIds).not.toContain(1);
  });

  it('includes archived at the end when query is set', () => {
    const tasks = [
      makeTask({ id: 1, status: 'archived', title: 'Archived task' }),
      makeTask({ id: 2, status: 'open', title: 'Open task' }),
    ];
    const groups = buildTaskSidebarGroups(tasks, [], 'task');
    const allTaskIds = groups.flatMap((g) => g.rows.map((r) => r.task.id));
    expect(allTaskIds).toContain(1);
    expect(allTaskIds).toContain(2);
    expect(allTaskIds[allTaskIds.length - 1]).toBe(1);
  });

  it('limits recent to RECENT_LIMIT', () => {
    const tasks = Array.from({ length: 15 }, (_, i) =>
      makeTask({ id: i + 1, updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
    );
    const groups = buildTaskSidebarGroups(tasks, [], '');
    const recentGroup = groups.find((g) => g.key === 'recent');
    expect(recentGroup).toBeDefined();
    expect(recentGroup!.rows.length).toBe(RECENT_LIMIT);
  });

  it('does not limit results when query is set', () => {
    const tasks = Array.from({ length: 15 }, (_, i) =>
      makeTask({ id: i + 1, title: 'Task', updatedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
    );
    const groups = buildTaskSidebarGroups(tasks, [], 'Task');
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    expect(total).toBe(15);
  });

  it('groups running before finished before recent', () => {
    const tasks = [
      makeTask({ id: 1, status: 'open' }),
      makeTask({ id: 2, status: 'open' }),
      makeTask({ id: 3, status: 'open' }),
    ];
    const rows: ActiveWindowRow[] = [
      makeActivity(1, 'running'),
      makeActivity(2, 'finished', { finishedAt: 200 }),
    ];
    const groups = buildTaskSidebarGroups(tasks, rows, '');
    expect(groups.map((g) => g.key)).toEqual(['running', 'finished', 'recent']);
  });

  it('omits empty groups', () => {
    const tasks = [makeTask({ id: 1 })];
    const groups = buildTaskSidebarGroups(tasks, [], '');
    expect(groups.length).toBe(1);
    expect(groups[0].key).toBe('recent');
  });

  it('sorts recent by openedAt when it is newer than taskTimestamp', () => {
    const tasks = [
      makeTask({ id: 1, title: 'Old but recently opened', updatedAt: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 2, title: 'Newer but never opened', updatedAt: '2026-01-05T00:00:00Z' }),
    ];
    const openedAt = { 1: new Date('2026-01-10T00:00:00Z').getTime() };
    const groups = buildTaskSidebarGroups(tasks, [], '', openedAt);
    const recentGroup = groups.find((g) => g.key === 'recent');
    expect(recentGroup!.rows.map((r) => r.task.id)).toEqual([1, 2]);
  });

  it('falls back to taskTimestamp for tasks that were never opened', () => {
    const tasks = [
      makeTask({ id: 1, title: 'Opened long ago', updatedAt: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 2, title: 'Never opened, more recent update', updatedAt: '2026-01-05T00:00:00Z' }),
    ];
    const openedAt = { 1: new Date('2026-01-02T00:00:00Z').getTime() };
    const groups = buildTaskSidebarGroups(tasks, [], '', openedAt);
    const recentGroup = groups.find((g) => g.key === 'recent');
    // task 2's own updatedAt (01-05) still beats task 1's max(openedAt, updatedAt) = 01-02.
    expect(recentGroup!.rows.map((r) => r.task.id)).toEqual([2, 1]);
  });

  it('defaults to empty openedAt when omitted, preserving taskTimestamp order', () => {
    const tasks = [
      makeTask({ id: 1, updatedAt: '2026-01-01T00:00:00Z' }),
      makeTask({ id: 2, updatedAt: '2026-01-05T00:00:00Z' }),
    ];
    const groups = buildTaskSidebarGroups(tasks, [], '');
    const recentGroup = groups.find((g) => g.key === 'recent');
    expect(recentGroup!.rows.map((r) => r.task.id)).toEqual([2, 1]);
  });
});
