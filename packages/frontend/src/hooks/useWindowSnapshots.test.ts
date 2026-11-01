import { expect, it } from 'vitest';
import { mergeWindowSnapshots } from './useWindowSnapshots';

it('keeps content for unchanged results and retains error details until the next successful capture', () => {
  const previous = new Map([[1, { id: 1, content: 'old', activity: 4 }]]);
  const unchanged = mergeWindowSnapshots(previous, [{ id: 1, status: 'unchanged', activity: 4 }]);
  expect(unchanged.get(1)).toEqual({ id: 1, content: 'old', activity: 4 });
  const failed = mergeWindowSnapshots(unchanged, [{ id: 1, status: 'error', code: 'capture_failed', message: 'failed' }]);
  expect(failed.get(1)).toEqual({ id: 1, content: 'old', activity: null, error: { code: 'capture_failed', message: 'failed' } });
  const recovered = mergeWindowSnapshots(failed, [{ id: 1, status: 'ok', content: 'new', activity: 5, changed: true }]);
  expect(recovered.get(1)).toEqual({ id: 1, content: 'new', activity: 5 });
});
