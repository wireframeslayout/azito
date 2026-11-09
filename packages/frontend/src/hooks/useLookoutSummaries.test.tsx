import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LookoutItem } from '../lib/lookoutSummary';
import { useLookoutSummaries } from './useLookoutSummaries';
import { notifyLookoutSettingsChanged } from '../lib/lookoutSettingsEvents';

const api = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ apiWithStatus: api }));
const item = { key: 'one', status: 'working', primaryRow: { windowId: 7 } } as LookoutItem;

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
describe('useLookoutSummaries', () => {
  it('requests visible window IDs and maps ready results', async () => {
    api.mockResolvedValue({ status: 200, body: { summaries: [{ windowId: 7, status: 'ready', summary: 'Working' }] } });
    const { result, rerender } = renderHook(({ open }) => useLookoutSummaries([item], open), { initialProps: { open: true } });
    await waitFor(() => expect(result.current.get('one')).toEqual({ status: 'ready', text: 'Working' }));
    expect(api.mock.calls[0][0]).toContain(encodeURIComponent(JSON.stringify([{ windowId: 7, state: 'working' }])));
    rerender({ open: false });
    expect(result.current.size).toBe(0);
  });
  it('polls pending results and stops when closed', async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({ status: 200, body: { summaries: [{ windowId: 7, status: 'pending' }] } });
    const { rerender } = renderHook(({ open }) => useLookoutSummaries([item], open), { initialProps: { open: true } });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api).toHaveBeenCalledTimes(2);
    rerender({ open: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('refreshes an open panel when settings are saved', async () => {
    api.mockResolvedValueOnce({ status: 200, body: { summaries: [{ windowId: 7, status: 'ready', summary: 'Old' }] } })
      .mockResolvedValueOnce({ status: 200, body: { summaries: [{ windowId: 7, status: 'off' }] } });
    const { result } = renderHook(() => useLookoutSummaries([item], true));
    await waitFor(() => expect(result.current.get('one')).toEqual({ status: 'ready', text: 'Old' }));
    act(() => notifyLookoutSettingsChanged());
    await waitFor(() => expect(result.current.size).toBe(0));
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('shows unavailable for failed HTTP requests', async () => {
    api.mockResolvedValue({ status: 500, body: {} });
    const { result } = renderHook(() => useLookoutSummaries([item], true));
    await waitFor(() => expect(result.current.get('one')).toEqual({ status: 'error' }));
  });
});
