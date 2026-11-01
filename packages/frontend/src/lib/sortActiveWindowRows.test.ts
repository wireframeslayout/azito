import { expect, it } from 'vitest';
import type { ActiveWindowRow } from '../hooks/useActiveWindowRows';
import { sortActiveWindowRows } from './sortActiveWindowRows';

it('orders blocked, working, unread and seen, newest completion first without mutating input', () => {
  const row = (key: string, fields: Partial<ActiveWindowRow>): ActiveWindowRow => ({ key, title: key, serverName: 's', target: key, status: 'running', ...fields });
  const rows = [row('seen-old', { status: 'finished', finishedAt: 1, seenAt: 3 }), row('unread', { status: 'finished', finishedAt: 2 }), row('working', {}), row('seen-new', { status: 'finished', finishedAt: 2, seenAt: 3 }), row('blocked', { activityStatus: 'blocked' })];
  expect(sortActiveWindowRows(rows).map((r) => r.key)).toEqual(['blocked', 'working', 'unread', 'seen-new', 'seen-old']);
  expect(rows[0].key).toBe('seen-old');
});
