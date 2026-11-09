import { useCallback, useEffect, useState } from 'react';
import { apiWithStatus } from '../api/client';
import { useNotificationChannel } from './useNotificationChannel';

interface OperationLink { taskId: number; sourceWindowId: number; targetWindowId: number }
const MAX_TASK_IDS = 500;

export function useOperationLinks(taskIds: number[]): { parents: ReadonlyMap<number, number>; error: boolean; reload: () => void } {
  const key = [...new Set(taskIds)].sort((a, b) => a - b).join(',');
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(n => n + 1), []);
  const [state, setState] = useState<{ key: string; parents: ReadonlyMap<number, number>; error: boolean }>({ key: '', parents: new Map(), error: false });
  useNotificationChannel({ onOrchestrationUpdated: reload, onTaskStatus: reload, onConnected: reload });
  useEffect(() => {
    let current = true;
    setState({ key, parents: new Map(), error: false });
    if (!key) return () => { current = false; };
    const ids = key.split(',');
    const requests = [];
    for (let i = 0; i < ids.length; i += MAX_TASK_IDS) {
      requests.push(apiWithStatus<OperationLink[]>(`/window-links?kind=operation&taskIds=${ids.slice(i, i + MAX_TASK_IDS).join(',')}`));
    }
    Promise.all(requests).then(responses => {
      if (!current) return;
      if (responses.some(response => response.status !== 200)) throw new Error('operation links request failed');
      setState({ key, parents: new Map(responses.flatMap(response => response.body).map(link => [link.targetWindowId, link.sourceWindowId])), error: false });
    }).catch(() => { if (current) setState({ key, parents: new Map(), error: true }); });
    return () => { current = false; };
  }, [key, revision]);
  return { ...(state.key === key ? state : { parents: new Map(), error: false }), reload };
}
