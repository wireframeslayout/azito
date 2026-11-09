import { useEffect, useState } from 'react';
import { apiWithStatus } from '../api/client';
import { useNotificationChannel } from './useNotificationChannel';

interface OperationLink { sourceWindowId: number; targetWindowId: number }

export function useOperationLinks(taskIds: number[]): { parents: ReadonlyMap<number, number>; error: boolean } {
  const key = [...new Set(taskIds)].sort((a, b) => a - b).join(',');
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; parents: ReadonlyMap<number, number>; error: boolean }>({ key: '', parents: new Map(), error: false });
  useNotificationChannel({ onOrchestrationUpdated: () => setRevision(n => n + 1), onConnected: () => setRevision(n => n + 1) });
  useEffect(() => {
    let current = true;
    setState({ key, parents: new Map(), error: false });
    if (!key) return () => { current = false; };
    apiWithStatus<OperationLink[]>(`/window-links?kind=operation&taskIds=${key}`).then(({ status, body }) => {
      if (!current) return;
      if (status !== 200) throw new Error('operation links request failed');
      setState({ key, parents: new Map(body.map(link => [link.targetWindowId, link.sourceWindowId])), error: false });
    }).catch(() => { if (current) setState({ key, parents: new Map(), error: true }); });
    return () => { current = false; };
  }, [key, revision]);
  return state.key === key ? state : { parents: new Map(), error: false };
}
