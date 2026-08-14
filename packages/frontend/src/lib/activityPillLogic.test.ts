import { describe, it, expect } from 'vitest';
import { groupRunningRows, readKeyFor, pruneStaleReadKeys } from './activityPillLogic';
import type { ActiveWindowRow } from '../hooks/useActiveWindowRows';

function row(overrides: Partial<ActiveWindowRow> & { key: string }): ActiveWindowRow {
  return {
    serverName: 's1',
    target: 'main:0',
    status: 'running',
    ...overrides,
  };
}

describe('groupRunningRows', () => {
  it('marks a group as blocked when a later row in the same group is blocked', () => {
    // Regression: aggregation used to look only at the first running row per group and
    // ignore subsequent rows, so a second blocked window in the same task was missed.
    const rows: ActiveWindowRow[] = [
      row({ key: 'a', taskId: 1, activityStatus: 'working' }),
      row({ key: 'b', taskId: 1, activityStatus: 'blocked' }),
    ];
    const groups = groupRunningRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].isBlocked).toBe(true);
  });

  it('keeps a group unblocked when no row in it is blocked', () => {
    const rows: ActiveWindowRow[] = [
      row({ key: 'a', taskId: 1, activityStatus: 'working' }),
      row({ key: 'b', taskId: 1, activityStatus: 'working' }),
    ];
    const groups = groupRunningRows(rows);
    expect(groups[0].isBlocked).toBe(false);
  });

  it('ignores non-running rows', () => {
    const rows: ActiveWindowRow[] = [
      row({ key: 'a', taskId: 1, status: 'finished' }),
    ];
    expect(groupRunningRows(rows)).toHaveLength(0);
  });

  it('groups by window key when taskId is absent', () => {
    const rows: ActiveWindowRow[] = [
      row({ key: 'w1', activityStatus: 'working' }),
      row({ key: 'w2', activityStatus: 'blocked' }),
    ];
    const groups = groupRunningRows(rows);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.groupKey === 'window:w2')?.isBlocked).toBe(true);
  });
});

describe('readKeyFor / pruneStaleReadKeys', () => {
  it('produces different keys for the same window key with different finishedAt', () => {
    // Regression: the same window re-running then re-finishing must be treated as a new,
    // unread completion even though row.key is identical.
    const first = readKeyFor({ key: 'w1', finishedAt: 1000 });
    const second = readKeyFor({ key: 'w1', finishedAt: 2000 });
    expect(first).not.toBe(second);
  });

  it('produces the same key for identical key+finishedAt', () => {
    expect(readKeyFor({ key: 'w1', finishedAt: 1000 })).toBe(readKeyFor({ key: 'w1', finishedAt: 1000 }));
  });

  it('prunes keys whose finishedAt is older than the cutoff', () => {
    const keys = new Set([readKeyFor({ key: 'w1', finishedAt: 1000 }), readKeyFor({ key: 'w2', finishedAt: 5000 })]);
    const pruned = pruneStaleReadKeys(keys, 3000);
    expect(pruned.has(readKeyFor({ key: 'w1', finishedAt: 1000 }))).toBe(false);
    expect(pruned.has(readKeyFor({ key: 'w2', finishedAt: 5000 }))).toBe(true);
  });
});
