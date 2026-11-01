import { useEffect, useRef, useState } from 'react';
import { apiWithStatus } from '../api/client';

export type WindowSnapshot = { status: 'ok'; id: number; content: string; activity: number | null; changed: true } | { status: 'unchanged'; id: number; activity: number } | { status: 'error'; id: number; code: string; message: string };
export interface WindowSnapshotState { id: number; content: string; activity: number | null; error?: { code: string; message: string } }
export interface WindowSnapshotOptions { lines?: number; intervalMs?: number; enabled: boolean }
export function useWindowSnapshots(ids: number[], { lines = 12, intervalMs = 3000, enabled }: WindowSnapshotOptions): { snapshots: Map<number, WindowSnapshotState>; refresh: () => void } {
  const key = ids.join(',');
  const [snapshots, setSnapshots] = useState<Map<number, WindowSnapshotState>>(() => new Map());
  const latest = useRef<Map<number, WindowSnapshotState>>(new Map());
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let running = false;
    let generation = 0;
    let refreshPending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const selected = key ? key.split(',').map(Number) : [];
    latest.current = new Map();
    setSnapshots(new Map());
    const poll = async (): Promise<void> => {
      if (disposed || !enabled || document.hidden || selected.length === 0) return;
      if (running) { refreshPending = true; return; }
      if (timer) clearTimeout(timer);
      running = true;
      const requestGeneration = generation;
      const since = [...latest.current.values()].filter((s) => s.activity !== null && !s.error).map((s) => `${s.id}:${s.activity}`).join(',');
      const params = new URLSearchParams({ ids: key, lines: String(lines) });
      if (since) params.set('since', since);
      try {
        const response = await apiWithStatus<{ snapshots: WindowSnapshot[] }>(`/windows/snapshots?${params}`);
        if (response.status !== 200) throw new Error('Failed to load snapshots');
        if (disposed || document.hidden || requestGeneration !== generation) return;
        const next = mergeWindowSnapshots(latest.current, response.body.snapshots);
        latest.current = next;
        setSnapshots(next);
      } catch {
        if (!disposed && !document.hidden && requestGeneration === generation) {
          const next = new Map(selected.map((id) => [id, { id, content: latest.current.get(id)?.content ?? '', activity: null, error: { code: 'capture_failed', message: 'Failed to load snapshots' } }]));
          latest.current = next;
          setSnapshots(next);
        }
      } finally {
        running = false;
        if (!disposed && enabled && !document.hidden) {
          if (refreshPending) { refreshPending = false; void poll(); }
          else timer = setTimeout(poll, intervalMs);
        }
      }
    };
    refreshRef.current = () => { void poll(); };
    const visibility = (): void => {
      generation++;
      if (timer) clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    document.addEventListener('visibilitychange', visibility);
    void poll();
    return () => { disposed = true; refreshRef.current = () => {}; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [key, lines, enabled, intervalMs]);
  return { snapshots, refresh: () => refreshRef.current() };
}

export function mergeWindowSnapshots(previousSnapshots: Map<number, WindowSnapshotState>, results: WindowSnapshot[]): Map<number, WindowSnapshotState> {
  const next = new Map<number, WindowSnapshotState>();
  for (const item of results) {
    const previous = previousSnapshots.get(item.id);
    if (item.status === 'ok') next.set(item.id, { id: item.id, content: item.content, activity: item.activity });
    else if (item.status === 'unchanged' && previous) next.set(item.id, { id: item.id, content: previous.content, activity: item.activity });
    else next.set(item.id, { id: item.id, content: previous?.content ?? '', activity: null, error: item.status === 'error' ? { code: item.code, message: item.message } : { code: 'capture_failed', message: 'Snapshot unavailable' } });
  }
  return next;
}
