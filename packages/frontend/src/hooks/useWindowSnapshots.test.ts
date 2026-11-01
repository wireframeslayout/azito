import { expect, it } from 'vitest';
import { mergeWindowSnapshots, snapshotSince } from './useWindowSnapshots';

it('keeps content for unchanged results and retains error details until the next successful capture', () => {
  const previous = new Map([[1, { id: 1, content: 'old', activity: 4 }]]);
  const unchanged = mergeWindowSnapshots(previous, [{ id: 1, status: 'unchanged', activity: 4 }], 0);
  expect(unchanged.get(1)).toEqual({ id: 1, content: 'old', activity: 4, activityConfirmed: true });
  const failed = mergeWindowSnapshots(unchanged, [{ id: 1, status: 'error', code: 'capture_failed', message: 'failed' }], 1);
  expect(failed.get(1)).toEqual({ id: 1, content: 'old', activity: null, error: { code: 'capture_failed', message: 'failed' } });
  const recovered = mergeWindowSnapshots(failed, [{ id: 1, status: 'ok', content: 'new', activity: 5, changed: true }], 2);
  expect(recovered.get(1)).toEqual({ id: 1, content: 'new', activity: 5, activityConfirmed: false, activityObservedAt: 2 });
});

it('confirms only after a full second, and starts again for a new activity', () => {
  const ok = (activity: number | null, content: string) => [{ id: 1, status: 'ok' as const, content, activity, changed: true as const }];
  let state = mergeWindowSnapshots(new Map(), ok(100, 'first'), 10_000);
  expect(snapshotSince(state)).toBe('');
  state = mergeWindowSnapshots(state, ok(100, 'early refresh'), 10_999);
  expect(snapshotSince(state)).toBe('');
  state = mergeWindowSnapshots(state, ok(100, 'later output'), 11_000);
  expect(state.get(1)?.content).toBe('later output');
  expect(snapshotSince(state)).toBe('1:100');
  state = mergeWindowSnapshots(state, [{ id: 1, status: 'unchanged', activity: 100 }], 12_000);
  expect(snapshotSince(state)).toBe('1:100');
  state = mergeWindowSnapshots(state, ok(101, 'new activity'), 12_100);
  expect(snapshotSince(state)).toBe('');
  state = mergeWindowSnapshots(state, ok(101, 'confirmed'), 13_100);
  expect(snapshotSince(state)).toBe('1:101');
  state = mergeWindowSnapshots(state, ok(null, 'unknown'), 14_100);
  expect(snapshotSince(state)).toBe('');
});
