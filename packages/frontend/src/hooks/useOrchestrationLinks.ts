import { useCallback, useEffect, useRef, useState } from 'react';
import { apiWithStatus } from '../api/client';
import type { WindowLinkView } from '../pages/workspace/types';
import { useNotificationChannel } from './useNotificationChannel';

export type LinkTarget = { targetWindowId: number } | { taskId: number };
export class LinkRequestError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export function useOrchestrationLinks(windowId: number | null): {
  links: WindowLinkView[]; loading: boolean; error: Error | null;
  refresh: () => Promise<void>; add: (target: LinkTarget) => Promise<void>;
  unlink: (link: WindowLinkView) => Promise<LinkTarget>; undo: (target: LinkTarget) => Promise<void>;
} {
  const [links, setLinks] = useState<WindowLinkView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const generation = useRef(0);
  const currentWindow = useRef(windowId);
  currentWindow.current = windowId;
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    if (windowId === null) { setLinks([]); setLoading(false); setError(null); return; }
    setLoading(true);
    try {
      const result = await apiWithStatus<WindowLinkView[] | { error: string }>(`/windows/${windowId}/links?kind=orchestration`);
      if (result.status !== 200 || !Array.isArray(result.body)) throw new LinkRequestError(!Array.isArray(result.body) ? result.body.error : 'request_failed');
      if (version === generation.current && currentWindow.current === windowId) { setLinks(result.body); setError(null); }
    } catch (cause) {
      if (version === generation.current && currentWindow.current === windowId) setError(cause instanceof Error ? cause : new Error('request_failed'));
    } finally {
      if (version === generation.current && currentWindow.current === windowId) setLoading(false);
    }
  }, [windowId]);
  useEffect(() => { setLinks([]); void refresh(); return () => { generation.current++; }; }, [refresh]);
  useNotificationChannel({ onOrchestrationUpdated: ({ windowId: changed }) => { if (changed === windowId) void refresh(); }, onConnected: () => { void refresh(); } });
  const mutate = useCallback(async (path: string, options: RequestInit) => {
    if (windowId === null) throw new LinkRequestError('not_found');
    try {
      const result = await apiWithStatus<{ error?: string }>(path, options);
      if (result.status < 200 || result.status >= 300) throw new LinkRequestError(result.body.error ?? 'request_failed');
      if (currentWindow.current === windowId) await refresh();
    } catch (cause) {
      const failure = cause instanceof Error ? cause : new Error('request_failed');
      if (currentWindow.current === windowId) setError(failure);
      throw failure;
    }
  }, [windowId, refresh]);
  const add = useCallback((target: LinkTarget) => mutate(`/windows/${windowId}/links`, { method: 'POST', body: JSON.stringify(target) }), [windowId, mutate]);
  const unlink = useCallback(async (link: WindowLinkView): Promise<LinkTarget> => {
    if (link.taskId === null && link.targetWindowId === null) throw new LinkRequestError('invalid_target');
    const target: LinkTarget = link.taskId !== null ? { taskId: link.taskId } : { targetWindowId: link.targetWindowId as number };
    await mutate(`/windows/${windowId}/links/${link.id}`, { method: 'DELETE' });
    return target;
  }, [windowId, mutate]);
  return { links, loading, error, refresh, add, unlink, undo: add };
}
