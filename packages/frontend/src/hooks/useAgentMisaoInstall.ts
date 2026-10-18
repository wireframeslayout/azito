import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { errorMessageOf } from '../lib/apiResult';
import { interpretInstallProgress, type MisaoInstallProgress } from '../lib/misaoInstallProgress';

export type AgentMisaoAction = 'install' | 'update';

export interface AgentMisaoInstallState {
  /** An install or update is running (started here, or already running when the row appeared). */
  installing: boolean;
  /** What a run started by this hook is doing; null when nothing runs, or the run was started elsewhere. */
  action: AgentMisaoAction | null;
  /** The step in progress (the last one reported). */
  step: string | null;
  /** The hub's refusal or failure text of the last run. */
  error: string | null;
}

interface UseAgentMisaoInstall extends AgentMisaoInstallState {
  install: () => Promise<void>;
  /** The explicit switch of a running older release to the bundled one. It ends every pane of the server: ask first. */
  update: () => Promise<void>;
}

const POLL_MS = 1000;

/**
 * Installs misao on an agent server (`POST /servers/:name/install-misao`), or updates it (`.../update-misao`), and follows
 * how far it got while the request runs (both report through `GET .../install-misao`). `onChanged` runs after a
 * successful run, so the rows that depend on the daemon are checked again.
 * `enabled` is false for a server that has no such install (a local one): nothing is asked of the hub then.
 */
export function useAgentMisaoInstall(serverName: string, onChanged: () => void, enabled = true): UseAgentMisaoInstall {
  const [state, setState] = useState<AgentMisaoInstallState>({ installing: false, action: null, step: null, error: null });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);
  /** True while the POST of this hook is in flight: its answer decides then, not a poll that may still see the previous run. */
  const ownRun = useRef(false);
  const path = `/servers/${encodeURIComponent(serverName)}/install-misao`;

  const stopPolling = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  // Applies a progress report. A run this hook did not start ends here (another tab's, or the window offer's).
  const follow = useCallback((progress: MisaoInstallProgress) => {
    const outcome = interpretInstallProgress(progress);
    if (outcome.kind === 'running') {
      setState((s) => ({ ...s, installing: true, step: outcome.step ?? s.step }));
      return;
    }
    if (ownRun.current || outcome.kind === 'idle') return;
    stopPolling();
    if (outcome.kind === 'done') {
      setState({ installing: false, action: null, step: null, error: null });
      onChanged();
    } else {
      setState({ installing: false, action: null, step: null, error: outcome.error });
    }
  }, [stopPolling, onChanged]);

  const poll = useCallback(async () => {
    try {
      const progress = await api<MisaoInstallProgress>(path);
      if (!alive.current || errorMessageOf(progress) !== null) return;
      follow(progress);
    } catch {
      // A poll that fails is not the install failing: the POST below reports that.
    }
  }, [path, follow]);

  const startPolling = useCallback(() => {
    stopPolling();
    timer.current = setInterval(() => { void poll(); }, POLL_MS);
  }, [poll, stopPolling]);

  // An install already running when the row appears (started from another tab, or by the offer when creating a window).
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    void (async () => {
      try {
        const progress = await api<MisaoInstallProgress>(path);
        if (!alive.current || errorMessageOf(progress) !== null) return;
        if (progress.state === 'running') {
          follow(progress);
          startPolling();
        }
      } catch {
        // No progress to show: the row still works.
      }
    })();
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, [path, enabled, follow, startPolling, stopPolling]);

  const run = useCallback(async (action: AgentMisaoAction) => {
    setState({ installing: true, action, step: null, error: null });
    ownRun.current = true;
    startPolling();
    try {
      const res = await api<unknown>(`/servers/${encodeURIComponent(serverName)}/${action}-misao`, { method: 'POST' });
      if (!alive.current) return;
      const failure = errorMessageOf(res);
      stopPolling();
      if (failure !== null) {
        setState({ installing: false, action: null, step: null, error: failure });
        return;
      }
      setState({ installing: false, action: null, step: null, error: null });
      onChanged();
    } catch (err) {
      stopPolling();
      if (alive.current) setState({ installing: false, action: null, step: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      ownRun.current = false;
    }
  }, [serverName, startPolling, stopPolling, onChanged]);

  const install = useCallback(() => run('install'), [run]);
  const update = useCallback(() => run('update'), [run]);

  return { ...state, install, update };
}
