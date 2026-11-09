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
    api.mockResolvedValue({ status: 200, body: { summaries: [{ windowId: 7, status: 'ready', text: 'Working' }] } });
    const { result, rerender } = renderHook(({ open }) => useLookoutSummaries([item], open), { initialProps: { open: true } });
    await waitFor(() => expect(result.current.get('one')).toEqual({ status: 'ready', text: 'Working' }));
    const params = new URLSearchParams(api.mock.calls[0][0].split('?')[1]);
    expect(params.get('windowIds')).toBe('7');
    expect(JSON.parse(params.get('states')!)).toEqual([{ windowId: 7, state: 'working' }]);
    rerender({ open: false });
    expect(result.current.size).toBe(0);
  });
  it('uses finished as the state of completed windows', async () => {
    api.mockResolvedValue({ status: 200, body: { summaries: [{ windowId: 7, status: 'none' }] } });
    renderHook(() => useLookoutSummaries([{ ...item, status: 'finished' }], true));
    await waitFor(() => expect(api).toHaveBeenCalled());
    const params = new URLSearchParams(api.mock.calls[0][0].split('?')[1]);
    expect(JSON.parse(params.get('states')!)).toEqual([{ windowId: 7, state: 'finished' }]);
  });
  it('shows the previous summary while a newer one is pending and polls at the refresh interval', async () => {
    vi.useFakeTimers();
    api.mockResolvedValue({ status: 200, body: { summaries: [{ windowId: 7, status: 'pending', text: 'Earlier' }] } });
    const { result } = renderHook(() => useLookoutSummaries([item], true));
    await act(async () => {});
    expect(result.current.get('one')).toEqual({ status: 'ready', text: 'Earlier' });
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(api).toHaveBeenCalledTimes(2);
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
    api.mockResolvedValueOnce({ status: 200, body: { summaries: [{ windowId: 7, status: 'ready', text: 'Old' }] } })
      .mockResolvedValueOnce({ status: 200, body: { summaries: [{ windowId: 7, status: 'off' }] } });
    const { result } = renderHook(() => useLookoutSummaries([item], true));
    await waitFor(() => expect(result.current.get('one')).toEqual({ status: 'ready', text: 'Old' }));
    act(() => notifyLookoutSettingsChanged());
    await waitFor(() => expect(result.current.size).toBe(0));
    expect(api).toHaveBeenCalledTimes(2);
  });
  it('passes the failure reason to the summary display', async () => {
    api.mockResolvedValue({ status: 200, body: { summaries: [{ windowId: 7, status: 'unavailable', reason: 'timeout' }] } });
    const { result } = renderHook(() => useLookoutSummaries([item], true));
    await waitFor(() => expect(result.current.get('one')).toEqual({ status: 'error', reason: 'timeout' }));
  });
  it('shows unavailable for failed HTTP requests', async () => {
    api.mockResolvedValue({ status: 500, body: {} });
    const { result } = renderHook(() => useLookoutSummaries([item], true));
    await waitFor(() => expect(result.current.get('one')).toEqual({ status: 'error' }));
  });
  it('retries after a failed HTTP request', async () => {
    vi.useFakeTimers();
    api.mockResolvedValueOnce({ status: 500, body: {} })
      .mockResolvedValueOnce({ status: 200, body: { summaries: [{ windowId: 7, status: 'ready', text: 'Back' }] } });
    const { result } = renderHook(() => useLookoutSummaries([item], true));
    await act(async () => {});
    expect(result.current.get('one')).toEqual({ status: 'error' });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(result.current.get('one')).toEqual({ status: 'ready', text: 'Back' });
  });
});
