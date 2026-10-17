import { useCallback, useEffect, useState } from 'react';
import type { MisaoServiceStatus } from '@azito/shared';
import { api } from '../api/client';
import { errorMessageOf } from '../lib/apiResult';

export type MisaoServiceAction = 'install' | 'start' | 'update';

export interface MisaoServiceState {
  /** null until the first answer. */
  status: MisaoServiceStatus | null;
  loading: boolean;
  /** The status could not be fetched. */
  loadFailed: boolean;
  /** The action in flight, if any: it blocks every other one. */
  busy: MisaoServiceAction | null;
  /** The hub's refusal or failure text of the last action. */
  actionError: string | null;
}

interface UseMisaoService extends MisaoServiceState {
  refresh: () => Promise<void>;
  install: (opts?: { replaceSocketSetting?: boolean }) => Promise<void>;
  start: () => Promise<void>;
  /** Stops the daemon (closing every pane) and starts the bundled one. The caller must have confirmed. */
  update: () => Promise<void>;
}

const BASE = '/system/misao';

/**
 * The managed misao service of the hub host (`/api/system/misao`). `onChanged` runs after an action succeeded, so the
 * caller can re-check what depends on the daemon (the install status rows).
 */
export function useMisaoService(onChanged?: () => void): UseMisaoService {
  const [state, setState] = useState<MisaoServiceState>({ status: null, loading: true, loadFailed: false, busy: null, actionError: null });

  const refresh = useCallback(async () => {
    try {
      const res = await api<MisaoServiceStatus>(BASE);
      if (errorMessageOf(res) !== null) throw new Error('status request failed');
      setState((s) => ({ ...s, status: res, loading: false, loadFailed: false }));
    } catch {
      setState((s) => ({ ...s, loading: false, loadFailed: true }));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const run = useCallback(async (action: MisaoServiceAction, body?: Record<string, unknown>) => {
    setState((s) => ({ ...s, busy: action, actionError: null }));
    try {
      const res = await api<MisaoServiceStatus>(`${BASE}/${action}`, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      const failure = errorMessageOf(res);
      if (failure !== null) {
        setState((s) => ({ ...s, busy: null, actionError: failure }));
        return;
      }
      setState((s) => ({ ...s, status: res, busy: null }));
      onChanged?.();
    } catch (err) {
      setState((s) => ({ ...s, busy: null, actionError: err instanceof Error ? err.message : String(err) }));
    }
  }, [onChanged]);

  return {
    ...state,
    refresh,
    install: (opts) => run('install', opts?.replaceSocketSetting ? { replaceSocketSetting: true } : undefined),
    start: () => run('start'),
    update: () => run('update', { closeAllPanes: true }),
  };
}
