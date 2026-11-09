import { useEffect, useState } from 'react';
import { apiWithStatus } from '../api/client';
import { subscribeLookoutSettingsChanged } from '../lib/lookoutSettingsEvents';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { status, body } = await apiWithStatus<T>(path, options);
  if (status < 200 || status >= 300) throw new Error('Request failed');
  return body;
}
import type { LookoutItem } from '../lib/lookoutSummary';
import type { LookoutSummary } from '../components/lookout/LookoutRow';

interface RequestWindow { windowId: number; state: 'blocked' | 'working' | 'completed' }
interface ResponseSummary { windowId: number; status: 'ready' | 'pending' | 'off' | 'unavailable' | 'none'; summary?: string }

export function useLookoutSummaries(items: LookoutItem[], enabled: boolean): ReadonlyMap<string, LookoutSummary> {
  const requests = new Map<number, RequestWindow>();
  for (const item of items) {
    const windowId = item.primaryRow?.windowId;
    if (windowId == null || requests.has(windowId)) continue;
    requests.set(windowId, { windowId, state: item.status === 'finished' ? 'completed' : item.status === 'working' ? 'working' : 'blocked' });
  }
  const key = JSON.stringify(enabled ? Array.from(requests.values()) : []);
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeLookoutSettingsChanged(() => setRevision(value => value + 1)), []);
  const [response, setResponse] = useState<{ key: string; results: ResponseSummary[] }>({ key: '[]', results: [] });
  useEffect(() => {
    const windows = JSON.parse(key) as RequestWindow[];
    if (!windows.length) { setResponse({ key, results: [] }); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchSummaries = async () => {
      try {
        const batches = await Promise.all(Array.from({ length: Math.ceil(windows.length / 50) }, (_, i) =>
          request<{ summaries: ResponseSummary[] }>(`/lookout/summaries?windows=${encodeURIComponent(JSON.stringify(windows.slice(i * 50, i * 50 + 50)))}`)));
        if (cancelled) return;
        const next = batches.flatMap(batch => batch.summaries);
        setResponse({ key, results: next });
        if (next.some(result => result.status === 'pending')) timer = setTimeout(fetchSummaries, 3000);
      } catch {
        if (!cancelled) setResponse({ key, results: windows.map(({ windowId }) => ({ windowId, status: 'unavailable' })) });
      }
    };
    void fetchSummaries();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [key, revision]);
  const byId = new Map((response.key === key ? response.results : []).map(result => [result.windowId, result]));
  const mapped = new Map<string, LookoutSummary>();
  for (const item of items) {
    const result = item.primaryRow?.windowId == null ? undefined : byId.get(item.primaryRow.windowId);
    if (result?.status === 'ready' && result.summary != null) mapped.set(item.key, { status: 'ready', text: result.summary });
    else if (result?.status === 'pending') mapped.set(item.key, { status: 'pending' });
    else if (result?.status === 'unavailable') mapped.set(item.key, { status: 'error' });
  }
  return mapped;
}
