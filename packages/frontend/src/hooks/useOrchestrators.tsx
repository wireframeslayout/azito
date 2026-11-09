import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiWithStatus } from '../api/client';
import type { OrchestratorSummary } from '../pages/workspace/types';
import { useNotificationChannel } from './useNotificationChannel';

interface OrchestratorsContextValue {
  windows: OrchestratorSummary[];
  status: 'loading' | 'ready' | 'error';
  refresh: () => void;
}
const OrchestratorsContext = createContext<OrchestratorsContextValue | null>(null);

export function useOrchestrators(): OrchestratorsContextValue {
  const value = useContext(OrchestratorsContext);
  if (!value) throw new Error('useOrchestrators must be used within OrchestratorsProvider');
  return value;
}

export function OrchestratorsProvider({ children }: { children: ReactNode }): ReactNode {
  const [windows, setWindows] = useState<OrchestratorSummary[]>([]);
  const [status, setStatus] = useState<OrchestratorsContextValue['status']>('loading');
  const sequence = useRef(0);
  const refresh = useCallback((): void => {
    const current = ++sequence.current;
    apiWithStatus<OrchestratorSummary[]>('/orchestrators').then(({ status: responseStatus, body }) => {
      if (responseStatus < 200 || responseStatus >= 300 || !Array.isArray(body)) throw new Error('Could not load orchestrators');
      if (sequence.current !== current) return;
      setWindows(body);
      setStatus('ready');
    }).catch(() => {
      if (sequence.current === current) setStatus('error');
    });
  }, []);
  useEffect(() => {
    refresh();
    return () => { sequence.current++; };
  }, [refresh]);
  useNotificationChannel({ onConnected: refresh, onOrchestrationUpdated: refresh, onWorkspaceRefresh: refresh, onSessionsUpdated: refresh });
  return <OrchestratorsContext.Provider value={{ windows, status, refresh }}>{children}</OrchestratorsContext.Provider>;
}
