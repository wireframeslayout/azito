import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../files/backend/FilesBackend';
import type { StorageFilesBackend } from '../files/backend/StorageFilesBackend';

interface EntriesState {
  key: string;
  entries: FileEntry[];
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

function initialState(key: string): EntriesState {
  return { key, entries: [], nextCursor: null, loading: true, loadingMore: false, error: null };
}

export function useStorageEntries(backend: StorageFilesBackend, path: string) {
  const key = `${backend.source}\0${path}`;
  const [state, setState] = useState<EntriesState>(() => initialState(key));
  const request = useRef<{ key: string; generation: number; pending: boolean; cursor: string | null }>({ key, generation: 0, pending: false, cursor: null });
  if (request.current.key !== key) request.current = { key, generation: request.current.generation + 1, pending: false, cursor: null };

  const refresh = useCallback(async (): Promise<void> => {
    if (request.current.key !== key) return;
    const generation = ++request.current.generation;
    request.current.pending = true;
    request.current.cursor = null;
    setState(initialState(key));
    try {
      const page = await backend.listPage(path, null);
      if (request.current.generation !== generation || request.current.key !== key) return;
      request.current.cursor = page.nextCursor;
      setState({ key, entries: page.entries, nextCursor: page.nextCursor, loading: false, loadingMore: false, error: null });
    } catch (error) {
      if (request.current.generation !== generation || request.current.key !== key) return;
      setState({ ...initialState(key), loading: false, error: error instanceof Error ? error.message : 'Failed to load directory' });
    } finally {
      if (request.current.generation === generation && request.current.key === key) request.current.pending = false;
    }
  }, [backend, key, path]);

  useEffect(() => {
    void refresh();
    return () => { request.current.generation += 1; request.current.pending = false; };
  }, [refresh]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (state.key !== key || state.nextCursor === null || request.current.pending || request.current.cursor !== state.nextCursor) return;
    const cursor = state.nextCursor;
    const generation = request.current.generation;
    request.current.pending = true;
    setState((previous) => ({ ...previous, loadingMore: true, error: null }));
    try {
      const page = await backend.listPage(path, cursor);
      if (request.current.generation !== generation || request.current.key !== key) return;
      request.current.cursor = page.nextCursor;
      setState((previous) => ({ ...previous, entries: [...previous.entries, ...page.entries], nextCursor: page.nextCursor, loadingMore: false }));
    } catch (error) {
      if (request.current.generation !== generation || request.current.key !== key) return;
      setState((previous) => ({ ...previous, loadingMore: false, error: error instanceof Error ? error.message : 'Failed to load directory' }));
    } finally {
      if (request.current.generation === generation && request.current.key === key) request.current.pending = false;
    }
  }, [backend, key, path, state.key, state.nextCursor]);

  return { ...(state.key === key ? state : initialState(key)), refresh, loadMore };
}
