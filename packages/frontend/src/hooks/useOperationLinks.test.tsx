import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useOperationLinks } from './useOperationLinks';

const api = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ apiWithStatus: api }));
const notifications = vi.hoisted(() => ({ handlers: {} as { onTaskStatus?: () => void } }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: (handlers: typeof notifications.handlers) => { notifications.handlers = handlers; } }));

it('loads normalized task IDs and falls back to a flat tree on failure', async () => {
  api.mockResolvedValueOnce({ status: 200, body: [{ sourceWindowId: 1, targetWindowId: 2 }] });
  const { result, rerender } = renderHook(({ ids }) => useOperationLinks(ids), { initialProps: { ids: [2, 1, 2] } });
  await waitFor(() => expect(result.current.parents.get(2)).toBe(1));
  expect(api).toHaveBeenCalledWith('/window-links?kind=operation&taskIds=1,2');
  api.mockResolvedValueOnce({ status: 500, body: {} });
  rerender({ ids: [3] });
  await waitFor(() => expect(result.current.error).toBe(true));
  expect(result.current.parents.size).toBe(0);
  rerender({ ids: [] });
  expect(result.current.parents.size).toBe(0);
  expect(api).toHaveBeenCalledTimes(2);
});

it('ignores a response for a superseded task set', async () => {
  let resolveFirst!: (value: unknown) => void;
  api.mockReset();
  api.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
  api.mockResolvedValueOnce({ status: 200, body: [{ sourceWindowId: 3, targetWindowId: 4 }] });
  const { result, rerender } = renderHook(({ ids }) => useOperationLinks(ids), { initialProps: { ids: [1] } });
  rerender({ ids: [2] });
  await waitFor(() => expect(result.current.parents.get(4)).toBe(3));
  resolveFirst({ status: 200, body: [{ sourceWindowId: 1, targetWindowId: 2 }] });
  await waitFor(() => expect(result.current.parents.get(4)).toBe(3));
  expect(result.current.parents.has(2)).toBe(false);
});

it('splits large task sets and reloads on task status and explicit request', async () => {
  api.mockReset();
  api.mockResolvedValue({ status: 200, body: [] });
  const { result } = renderHook(() => useOperationLinks(Array.from({ length: 501 }, (_, i) => i + 1)));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(api.mock.calls[0][0].split('taskIds=')[1].split(',')).toHaveLength(500);
  expect(api.mock.calls[1][0]).toContain('taskIds=501');
  act(() => notifications.handlers.onTaskStatus?.());
  await waitFor(() => expect(api).toHaveBeenCalledTimes(4));
  act(() => result.current.reload());
  await waitFor(() => expect(api).toHaveBeenCalledTimes(6));
});
