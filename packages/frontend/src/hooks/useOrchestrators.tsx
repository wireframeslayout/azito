import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api/client';
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
    api<OrchestratorSummary[]>('/orchestrators').then((result) => {
      if (sequence.current !== current) return;
      setWindows(result);
      setStatus('ready');
    }).catch(() => {
      if (sequence.current === current) setStatus('error');
    });
  }, []);
  useEffect(() => {
    refresh();
    return () => { sequence.current++; };
  }, [refresh]);
  useNotificationChannel({ onConnected: refresh, onOrchestrationUpdated: refresh, onWorkspaceRefresh: refresh });
  return <OrchestratorsContext.Provider value={{ windows, status, refresh }}>{children}</OrchestratorsContext.Provider>;
}
