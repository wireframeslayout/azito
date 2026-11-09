import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { apiWithStatus } from '../api/client';
import { useOrchestrationLinks } from './useOrchestrationLinks';
vi.mock('../api/client', () => ({ apiWithStatus: vi.fn() }));
const events = vi.hoisted(() => ({ handler: undefined as ((event: { windowId: number }) => void) | undefined }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: (handlers: { onOrchestrationUpdated: typeof events.handler }) => { events.handler = handlers.onOrchestrationUpdated; } }));
it('loads orchestration links, refreshes on matching events, and ignores stale responses', async () => {
  const pending: Array<(value: { status: number; body: unknown }) => void> = [];
  vi.mocked(apiWithStatus).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  const { result } = renderHook(() => useOrchestrationLinks(1));
  expect(apiWithStatus).toHaveBeenCalledWith('/windows/1/links?kind=orchestration');
  act(() => events.handler?.({ windowId: 1 }));
  await act(async () => { pending[1]({ status: 200, body: [{ id: 2 }] }); });
  await act(async () => { pending[0]({ status: 200, body: [{ id: 1 }] }); });
  await waitFor(() => expect(result.current.links.map(item => item.id)).toEqual([2]));
});
