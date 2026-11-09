import { useEffect, useState } from 'react';
import { apiOk as request } from '../api/apiOk';
import { subscribeLookoutSettingsChanged } from '../lib/lookoutSettingsEvents';
import type { LookoutItem } from '../lib/lookoutSummary';
import type { LookoutSummary } from '../components/lookout/LookoutRow';

interface RequestWindow { windowId: number; state: 'blocked' | 'working' | 'finished' }
interface ResponseSummary { windowId: number; status: 'ready' | 'pending' | 'off' | 'unavailable' | 'none'; text?: string; reason?: 'cli_not_found' | 'not_logged_in' | 'timeout' | 'failed' }

export function useLookoutSummaries(items: LookoutItem[], enabled: boolean): ReadonlyMap<string, LookoutSummary> {
  const requests = new Map<number, RequestWindow>();
  for (const item of items) {
    const windowId = item.primaryRow?.windowId;
    if (windowId == null || requests.has(windowId)) continue;
    requests.set(windowId, { windowId, state: item.status === 'finished' ? 'finished' : item.status === 'working' ? 'working' : 'blocked' });
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
      if (document.visibilityState === 'hidden') { timer = setTimeout(fetchSummaries, 30000); return; }
      try {
        const batches = await Promise.all(Array.from({ length: Math.ceil(windows.length / 50) }, (_, i) => {
          const batch = windows.slice(i * 50, i * 50 + 50);
          const params = new URLSearchParams({ windowIds: batch.map(window => window.windowId).join(','), states: JSON.stringify(batch) });
          return request<{ summaries: ResponseSummary[] }>(`/lookout/summaries?${params}`);
        }));
        if (cancelled) return;
        const next = batches.flatMap(batch => batch.summaries);
        setResponse({ key, results: next });
        const pendingWithoutText = next.some(result => result.status === 'pending' && !result.text);
        if (next.some(result => result.status !== 'off' && result.status !== 'none')) {
          timer = setTimeout(fetchSummaries, pendingWithoutText ? 3000 : 120000);
        }
      } catch {
        if (cancelled) return;
        setResponse({ key, results: windows.map(({ windowId }) => ({ windowId, status: 'unavailable' })) });
        timer = setTimeout(fetchSummaries, 30000);
      }
    };
    void fetchSummaries();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [key, revision]);
  const byId = new Map((response.key === key ? response.results : []).map(result => [result.windowId, result]));
  const mapped = new Map<string, LookoutSummary>();
  for (const item of items) {
    const result = item.primaryRow?.windowId == null ? undefined : byId.get(item.primaryRow.windowId);
    // A pending result can carry the previous summary of the same conversation; show it while the newer one is made.
    if ((result?.status === 'ready' || result?.status === 'pending') && result.text != null) mapped.set(item.key, { status: 'ready', text: result.text });
    else if (result?.status === 'pending') mapped.set(item.key, { status: 'pending' });
    else if (result?.status === 'unavailable') mapped.set(item.key, { status: 'error', ...(result.reason && { reason: result.reason }) });
  }
  return mapped;
}
