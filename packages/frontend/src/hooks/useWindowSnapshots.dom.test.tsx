import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { apiWithStatus } from '../api/client';
import { useWindowSnapshots } from './useWindowSnapshots';
vi.mock('../api/client', () => ({ apiWithStatus: vi.fn() }));
it('retains snapshots for selected windows and drops those removed from view', async () => {
  const pending: Array<(value: { status: number; body: unknown }) => void> = [];
  vi.mocked(apiWithStatus).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const { result, rerender } = renderHook(({ ids }) => useWindowSnapshots(ids, { enabled: true }), { initialProps: { ids: [1, 2] } });
  pending[0]({ status: 200, body: { snapshots: [{ status: 'ok', id: 1, content: 'one', activity: 1 }, { status: 'ok', id: 2, content: 'two', activity: 1 }] } });
  await waitFor(() => expect(result.current.snapshots.size).toBe(2));
  rerender({ ids: [2, 3] });
  await waitFor(() => expect([...result.current.snapshots.keys()]).toEqual([2]));
  expect(result.current.snapshots.get(2)?.content).toBe('two');
  pending[1]({ status: 200, body: { snapshots: [{ status: 'ok', id: 2, content: 'new two', activity: 2 }, { status: 'ok', id: 3, content: 'three', activity: 1 }] } });
  await waitFor(() => expect([...result.current.snapshots.keys()]).toEqual([2, 3]));
});
