import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api/client';

export type SystemUpdateStatus = 'up-to-date' | 'checking' | 'update-available' | 'check-failed'
  | 'confirming' | 'running' | 'restarting' | 'success' | 'failed'
  | 'disabled' | 'blocked';

export type DeployMode = 'systemd' | 'launchd' | 'source';

export interface UpdateCommit {
  sha: string;
  message: string;
}

export interface UpdateStatusResponse {
  status: SystemUpdateStatus;
  currentVersion: string | null;
  currentCommit: string | null;
  latestVersion: string | null;
  latestCommit: string | null;
  latestDate: string | null;
  commits: UpdateCommit[];
  commitsBehind: number;
  repo: string | null;
  deployMode: DeployMode;
  runningTasks: number;
  disabledReason: string | null;
  channel: 'stable' | 'rc';
  /** 稼働検知診断の導線（Settings の診断節・ステータスバーのアイテム）を出してよいか。 */
  diagnosticsEnabled: boolean;
}

export interface VersionEntry {
  version: string;
  publishedAt: string;
  prerelease: boolean;
  relation: 'newer' | 'same' | 'older';
}

export type UpdateStep = 'download' | 'verify' | 'extract' | 'smoke-test' | 'switch' | 'restart' | 'health-check';
export type UpdateRunStatus = 'running' | 'success' | 'failed';

export interface UpdateStepEntry {
  step: UpdateStep;
  status: 'running' | 'ok' | 'error';
  message: string;
}

export interface UpdateState {
  status: UpdateRunStatus;
  step: UpdateStep;
  fromVersion: string;
  toVersion: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  steps: UpdateStepEntry[];
}

export interface UpdateProgressResponse {
  state: UpdateState | null;
  log: string[];
}

const STATUS_POLL_INTERVAL_MS = 3600000;
const PROGRESS_POLL_INTERVAL_MS = 2000;
const HEALTH_POLL_INTERVAL_MS = 2000;
const RELOAD_DELAY_MS = 1500;

interface SystemUpdateContextValue {
  status: UpdateStatusResponse | null;
  progress: UpdateProgressResponse | null;
  loading: boolean;
  checking: boolean;
  showOverlay: boolean;
  /**
   * Whether an update can be started right now. Kept here rather than
   * recomputed per screen so the status bar dropdown and the settings page
   * cannot drift apart on when the action is offered.
   */
  canStart: boolean;
  channel: 'stable' | 'rc' | null;
  versions: VersionEntry[];
  loadingVersions: boolean;
  checkNow: () => void;
  startUpdate: () => Promise<{ started: boolean; error?: string }>;
  startUpdateToVersion: (version: string) => Promise<{ started: boolean; error?: string }>;
  setChannel: (kind: 'stable' | 'rc') => Promise<void>;
  fetchVersions: () => Promise<void>;
  dismissOverlay: () => void;
}

const noop = () => {};

export const SystemUpdateContext = createContext<SystemUpdateContextValue>({
  status: null,
  progress: null,
  loading: false,
  checking: false,
  showOverlay: false,
  canStart: false,
  channel: null,
  versions: [],
  loadingVersions: false,
  checkNow: noop,
  startUpdate: async () => ({ started: false, error: 'not initialized' }),
  startUpdateToVersion: async () => ({ started: false, error: 'not initialized' }),
  setChannel: async () => {},
  fetchVersions: async () => {},
  dismissOverlay: noop,
});

export function useSystemUpdate(): SystemUpdateContextValue {
  return useContext(SystemUpdateContext);
}

function shouldShowOverlayForStatus(status: SystemUpdateStatus | undefined): boolean {
  return status === 'running' || status === 'restarting' || status === 'success' || status === 'failed';
}

export function SystemUpdateProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<UpdateStatusResponse | null>(null);
  const [progress, setProgress] = useState<UpdateProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [overlayDismissed, setOverlayDismissed] = useState(false);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [reloadScheduled, setReloadScheduled] = useState(false);
  const progressPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    setChecking(true);
    try {
      const result = await api<UpdateStatusResponse>('/system/update/status');
      setStatus(result);
    } catch {
      // ネットワークエラーやサーバー未応答時は前回の値を維持する
    } finally {
      setChecking(false);
      setLoading(false);
    }
  }, []);

  const fetchProgress = useCallback(async () => {
    const result = await api<UpdateProgressResponse>('/system/update/progress');
    setProgress(result);
    return result;
  }, []);

  const clearProgressPoll = useCallback(() => {
    if (progressPollRef.current) {
      clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }
  }, []);

  const clearHealthPoll = useCallback(() => {
    if (healthPollRef.current) {
      clearInterval(healthPollRef.current);
      healthPollRef.current = null;
    }
  }, []);

  const pollHealth = useCallback((fromVersion: string) => {
    clearHealthPoll();
    setRestarting(true);
    healthPollRef.current = setInterval(async () => {
      try {
        const health = await api<{ version?: string }>('/health');
        if (health.version && health.version !== fromVersion) {
          clearHealthPoll();
          setRestarting(false);
          setProgress((prev) => prev?.state ? {
            ...prev,
            state: { ...prev.state, status: 'success', step: 'health-check' },
          } : prev);
          setReloadScheduled(true);
        }
      } catch {
        // 再起動中はサーバー未応答が正常な状態のため、エラーとして扱わない
      }
    }, HEALTH_POLL_INTERVAL_MS);
  }, [clearHealthPoll]);

  const pollProgress = useCallback(() => {
    clearProgressPoll();
    progressPollRef.current = setInterval(async () => {
      try {
        const result = await fetchProgress();
        if (!result.state) {
          clearProgressPoll();
          return;
        }
        if (result.state.step === 'restart' && result.state.status === 'running') {
          clearProgressPoll();
          pollHealth(result.state.fromVersion);
          return;
        }
        if (result.state.status === 'success' || result.state.status === 'failed') {
          clearProgressPoll();
          if (result.state.status === 'success') setReloadScheduled(true);
        }
      } catch {
        // サーバー再起動の直前は一時的に到達不能になるため、エラーは無視して次回ポーリングに委ねる
      }
    }, PROGRESS_POLL_INTERVAL_MS);
  }, [clearProgressPoll, fetchProgress, pollHealth]);

  const checkNow = useCallback(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const startUpdate = useCallback(async (): Promise<{ started: boolean; error?: string }> => {
    const res = await api<{ started?: boolean; error?: string }>('/system/update', { method: 'POST' });
    if (res.started) {
      setOverlayDismissed(false);
      try { localStorage.removeItem('azito-update-dismissed'); } catch { /* localStorage unavailable */ }
      await fetchProgress();
      pollProgress();
      return { started: true };
    }
    return { started: false, error: res.error };
  }, [fetchProgress, pollProgress]);

  const fetchVersions = useCallback(async () => {
    setLoadingVersions(true);
    try {
      const result = await api<{ versions: VersionEntry[] }>('/system/update/versions');
      setVersions(result.versions);
    } catch {
      // Version listing is auxiliary to update status; keep the current list.
    } finally {
      setLoadingVersions(false);
    }
  }, []);

  const setChannel = useCallback(async (kind: 'stable' | 'rc') => {
    await api('/system/update/channel', {
      method: 'PUT',
      body: JSON.stringify({ channel: kind }),
    });
    await fetchStatus();
    if (kind === 'rc') {
      await fetchVersions();
    } else {
      setVersions([]);
    }
  }, [fetchStatus, fetchVersions]);

  const startUpdateToVersion = useCallback(async (version: string): Promise<{ started: boolean; error?: string }> => {
    const res = await api<{ started?: boolean; error?: string }>('/system/update', {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
    if (res.started) {
      setOverlayDismissed(false);
      try { localStorage.removeItem('azito-update-dismissed'); } catch { /* localStorage unavailable */ }
      await fetchProgress();
      pollProgress();
      return { started: true };
    }
    return { started: false, error: res.error };
  }, [fetchProgress, pollProgress]);

  const dismissOverlay = useCallback(() => {
    setOverlayDismissed(true);
    const state = progress?.state;
    if (state && (state.status === 'success' || state.status === 'failed') && state.completedAt) {
      try {
        localStorage.setItem('azito-update-dismissed', `${state.toVersion}:${state.completedAt}`);
      } catch { /* localStorage unavailable */ }
    }
  }, [progress]);

  // Initial mount: fetch status, and check progress in case the page was reloaded mid-update
  // (overlay recovery — the update was already running before this session started).
  useEffect(() => {
    void fetchStatus();
    void (async () => {
      const result = await fetchProgress();
      if (result.state?.status === 'running') {
        setOverlayDismissed(false);
        if (result.state.step === 'restart') {
          pollHealth(result.state.fromVersion);
        } else {
          pollProgress();
        }
      } else if (result.state && (result.state.status === 'success' || result.state.status === 'failed')) {
        try {
          const dismissed = localStorage.getItem('azito-update-dismissed');
          if (dismissed === `${result.state.toVersion}:${result.state.completedAt}`) {
            setOverlayDismissed(true);
          }
        } catch { /* localStorage unavailable */ }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const id = setInterval(fetchStatus, STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  useEffect(() => {
    if (status?.channel === 'rc') {
      void fetchVersions();
    }
  }, [status?.channel, fetchVersions]);

  useEffect(() => {
    return () => {
      clearProgressPoll();
      clearHealthPoll();
    };
  }, [clearProgressPoll, clearHealthPoll]);

  useEffect(() => {
    if (!reloadScheduled) return;
    const timer = setTimeout(() => window.location.reload(), RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [reloadScheduled]);

  const effectiveState: SystemUpdateStatus | undefined = restarting ? 'restarting' : progress?.state?.status;
  const showOverlay = !overlayDismissed && shouldShowOverlayForStatus(effectiveState);

  const canStart = status?.status === 'update-available' && status.runningTasks === 0;
  const channel = status?.channel ?? null;

  const value: SystemUpdateContextValue = {
    status,
    progress,
    loading,
    checking,
    showOverlay,
    canStart,
    channel,
    versions,
    loadingVersions,
    checkNow,
    startUpdate,
    startUpdateToVersion,
    setChannel,
    fetchVersions,
    dismissOverlay,
  };

  return (
    <SystemUpdateContext.Provider value={value}>
      {children}
    </SystemUpdateContext.Provider>
  );
}
