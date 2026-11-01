import { expect, it } from 'vitest';
import { mergeWindowSnapshots, snapshotSince } from './useWindowSnapshots';

it('keeps content for unchanged results and retains error details until the next successful capture', () => {
  const previous = new Map([[1, { id: 1, content: 'old', activity: 4 }]]);
  const unchanged = mergeWindowSnapshots(previous, [{ id: 1, status: 'unchanged', activity: 4 }]);
  expect(unchanged.get(1)).toEqual({ id: 1, content: 'old', activity: 4, activityConfirmed: true });
  const failed = mergeWindowSnapshots(unchanged, [{ id: 1, status: 'error', code: 'capture_failed', message: 'failed' }]);
  expect(failed.get(1)).toEqual({ id: 1, content: 'old', activity: null, error: { code: 'capture_failed', message: 'failed' } });
  const recovered = mergeWindowSnapshots(failed, [{ id: 1, status: 'ok', content: 'new', activity: 5, changed: true }]);
  expect(recovered.get(1)).toEqual({ id: 1, content: 'new', activity: 5, activityConfirmed: false });
});

it('recaptures once before confirming an activity and repeats that check when it changes', () => {
  const ok = (activity: number | null, content: string) => [{ id: 1, status: 'ok' as const, content, activity, changed: true as const }];
  let state = mergeWindowSnapshots(new Map(), ok(100, 'first'));
  expect(snapshotSince(state)).toBe('');
  state = mergeWindowSnapshots(state, ok(100, 'later in the same second'));
  expect(state.get(1)?.content).toBe('later in the same second');
  expect(snapshotSince(state)).toBe('1:100');
  state = mergeWindowSnapshots(state, [{ id: 1, status: 'unchanged', activity: 100 }]);
  expect(snapshotSince(state)).toBe('1:100');
  state = mergeWindowSnapshots(state, ok(101, 'new activity'));
  expect(snapshotSince(state)).toBe('');
  state = mergeWindowSnapshots(state, ok(101, 'confirmed'));
  expect(snapshotSince(state)).toBe('1:101');
  state = mergeWindowSnapshots(state, ok(null, 'unknown'));
  expect(snapshotSince(state)).toBe('');
});
