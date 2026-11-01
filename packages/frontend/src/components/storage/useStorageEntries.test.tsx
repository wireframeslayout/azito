// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StorageFilesBackend, type StoragePage } from '../files/backend/StorageFilesBackend';
import { useStorageEntries } from './useStorageEntries';

function deferred() {
  let resolve!: (page: StoragePage) => void;
  const promise = new Promise<StoragePage>((done) => { resolve = done; });
  return { promise, resolve };
}
const page = (name: string, nextCursor: string | null): StoragePage => ({ entries: [{ name, path: name, type: 'file' }], nextCursor });

describe('useStorageEntries', () => {
  it('suppresses concurrent requests and retains entries after a page error', async () => {
    const backend = new StorageFilesBackend(1);
    const next = deferred();
    const list = vi.spyOn(backend, 'listPage').mockResolvedValueOnce(page('a', 'next')).mockReturnValueOnce(next.promise).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useStorageEntries(backend, ''));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { void result.current.loadMore(); void result.current.loadMore(); });
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(page('b', 'last')));
    expect(result.current.entries.map((entry) => entry.name)).toEqual(['a', 'b']);
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.error).toBe('offline');
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.nextCursor).toBe('last');
  });
  it('ignores a response for a previous folder', async () => {
    const backend = new StorageFilesBackend(1);
    const old = deferred();
    vi.spyOn(backend, 'listPage').mockReturnValueOnce(old.promise).mockResolvedValueOnce(page('new', null));
    const { result, rerender } = renderHook(({ path }) => useStorageEntries(backend, path), { initialProps: { path: 'old/' } });
    rerender({ path: 'new/' });
    await waitFor(() => expect(result.current.entries[0]?.name).toBe('new'));
    await act(async () => old.resolve(page('old', null)));
    expect(result.current.entries[0]?.name).toBe('new');
  });
  it('ignores a refresh retained from a previous folder', async () => {
    const backend = new StorageFilesBackend(1);
    const current = deferred();
    const list = vi.spyOn(backend, 'listPage').mockResolvedValueOnce(page('old', null)).mockReturnValueOnce(current.promise);
    const { result, rerender } = renderHook(({ path }) => useStorageEntries(backend, path), { initialProps: { path: 'old/' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const oldRefresh = result.current.refresh;
    rerender({ path: 'new/' });
    await act(async () => { await oldRefresh(); });
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(page('new', null)));
    expect(result.current.entries[0]?.name).toBe('new');
    expect(result.current.loading).toBe(false);
  });
});
