import { describe, expect, it } from 'vitest';
import { buildLookoutSections } from './lookoutSummary';
import type { ActiveWindowRow } from '../hooks/useActiveWindowRows';
import type { Task, Window } from '../pages/workspace/types';

function row(key: string, overrides: Partial<ActiveWindowRow> = {}): ActiveWindowRow {
  return { key, title: key, serverName: 'local', target: key, status: 'running', ...overrides };
}
function task(id: number, status: string, windowIds: number[] = []): Task {
  return { id, title: `Task ${id}`, status, projectId: 1, unitId: null, priority: 0, createdAt: '', updatedAt: '', windows: windowIds.map((id) => ({ id } as Window)) };
}

describe('buildLookoutSections', () => {
  it('deduplicates task windows and prioritizes blocked rows while counting failures', () => {
    const result = buildLookoutSections({
      rows: [row('one', { taskId: 1 }), row('two', { taskId: 1, activityStatus: 'blocked' }), row('three', { windowId: 30 })],
      allTasks: [task(1, 'failed', [10, 11]), task(2, 'phase_review')], lastSeenMs: 0,
    });
    expect(result.attention.map((item) => item.status)).toEqual(['blocked', 'phase_review']);
    expect(result.attention[0]).toMatchObject({ activeWindows: 2, totalWindows: 2, windowNames: ['one', 'two'], primaryRow: { key: 'two' } });
    expect(result.active.map((item) => item.title)).toEqual(['three']);
    expect(result.counts).toEqual({ attention: 2, active: 1, finished: 0, failed: 1 });
  });

  it('orders attention tasks by most recent update', () => {
    const older = { ...task(1, 'waiting_input'), updatedAt: '2026-01-01T00:00:00Z' };
    const newer = { ...task(2, 'phase_review'), updatedAt: '2026-02-01T00:00:00Z' };
    const result = buildLookoutSections({ rows: [], allTasks: [older, newer], lastSeenMs: 0 });
    expect(result.attention.map(item => item.task?.id)).toEqual([2, 1]);
  });

  it('uses the latest completion per window strictly after last seen', () => {
    const result = buildLookoutSections({ rows: [
      row('a', { status: 'finished', finishedAt: 11 }), row('a', { status: 'finished', finishedAt: 15 }),
      row('b', { status: 'finished', finishedAt: 10 }),
    ], allTasks: [], lastSeenMs: 10 });
    expect(result.finished).toHaveLength(1);
    expect(result.finished[0].primaryRow?.finishedAt).toBe(15);
  });

  it('limits rows and tasks to the selected windows, including catalog associations', () => {
    const result = buildLookoutSections({ rows: [row('selected', { windowId: 10 }), row('other', { taskId: 2, windowId: 20 })],
      allTasks: [task(1, 'waiting_input', [10]), task(2, 'pending_approval', [20]), task(3, 'failed')],
      lastSeenMs: 0, scope: { windowIds: new Set([10]) } });
    expect(result.attention).toHaveLength(1);
    expect(result.attention[0]).toMatchObject({ task: { id: 1 }, activeWindows: 1 });
    expect(result.active).toHaveLength(0);
    expect(result.counts.failed).toBe(0);
  });
});
