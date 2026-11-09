import { expect, it } from 'vitest';
import { addEvent, flushBatch, type PendingEvent } from './lookoutBatch';
it('deduplicates in arrival order without mutation and aggregates names and counts', () => {
  const empty: PendingEvent[] = [];
  const first = addEvent(empty, { key: 'a', title: 'A', kind: 'attention', at: 1 });
  const duplicate = addEvent(first, { key: 'a', title: 'other', kind: 'failed', at: 2 });
  const batch = addEvent(duplicate, { key: 'b', title: 'B', kind: 'finished', at: 3 });
  const three = addEvent(batch, { key: 'c', title: 'C', kind: 'failed', at: 4 });
  expect(empty).toEqual([]);
  expect(first).toHaveLength(1);
  expect(flushBatch(empty)).toBeNull();
  expect(flushBatch(three)).toEqual({ attention: 1, finished: 1, failed: 1, names: ['A', 'B'] });
});
