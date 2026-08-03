import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AgentActivityPayload } from '../types/notification';
import { useNotificationChannel } from './useNotificationChannel';
import { useWorkspaceTargets } from './useWorkspaceTargets';

export interface AgentActivityInfo {
  serverName: string;
  target: string;
  running: boolean;
  source: 'operation' | 'manual' | 'supervised';
  taskId?: number;
  projectId?: number;
  label?: string;
  status: 'working' | 'blocked';
  paneName?: string;
}

interface AgentActivitySnapshotEntry {
  serverName: string;
  target: string;
  running: boolean;
  source: 'operation' | 'manual' | 'supervised';
  taskId?: number;
  projectId?: number;
  label?: string;
  status?: 'working' | 'blocked';
  paneName?: string;
}

export interface FinishedEntry {
  serverName: string;
  target: string;
  label?: string;
  taskId?: number;
  projectId?: number;
  finishedAt: number;
  paneName?: string;
}

export type ActivityIndicator = 'working' | 'blocked' | 'finished' | null;

interface AgentActivityContextValue {
  entries: Map<string, AgentActivityInfo>;
  isRunning: (serverName: string, target: string) => boolean;
  shouldShowActivity: (serverName: string, target: string) => boolean;
  shouldShowTaskActivity: (taskId: number) => boolean;
  isWatched: (serverName: string, target: string, taskId?: number) => boolean;
  windowIndicator: (serverName: string, target: string) => ActivityIndicator;
  finishedEntries: FinishedEntry[];
  dismissFinished: (serverName: string, target: string) => void;
}

const AgentActivityContext = createContext<AgentActivityContextValue>({
  entries: new Map(),
  isRunning: () => false,
  shouldShowActivity: () => false,
  shouldShowTaskActivity: () => false,
  isWatched: () => false,
  windowIndicator: () => null,
  finishedEntries: [],
  dismissFinished: () => {},
});

export function activityKey(serverName: string, target: string): string {
  return `${serverName}::${target}`;
}

function snapshotToMap(snapshot: AgentActivitySnapshotEntry[]): Map<string, AgentActivityInfo> {
  const map = new Map<string, AgentActivityInfo>();
  for (const e of snapshot) {
    if (!e.running) continue;
    map.set(activityKey(e.serverName, e.target), {
      serverName: e.serverName,
      target: e.target,
      running: true,
      source: e.source,
      taskId: e.taskId,
      projectId: e.projectId,
      label: e.label,
      status: e.status ?? 'working',
      paneName: e.paneName,
    });
  }
  return map;
}

function useBrowserFocused(): boolean {
  const [focused, setFocused] = useState(
    () => document.hasFocus() && document.visibilityState === 'visible',
  );

  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && document.visibilityState === 'visible');
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  return focused;
}

const FINISHED_STORAGE_KEY = 'active-windows-finished';

function loadFinishedEntries(): FinishedEntry[] {
  try {
    const raw = localStorage.getItem(FINISHED_STORAGE_KEY);
    if (!raw) return [];
    const json = JSON.parse(raw);
    const parsed: unknown[] = Array.isArray(json) ? json : [];
    return parsed.filter((e): e is FinishedEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as FinishedEntry).serverName === 'string' &&
      typeof (e as FinishedEntry).target === 'string' &&
      typeof (e as FinishedEntry).finishedAt === 'number',
    );
  } catch {
    return [];
  }
}

function saveFinishedEntries(entries: FinishedEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(FINISHED_STORAGE_KEY);
    else localStorage.setItem(FINISHED_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* best-effort */
  }
}

export function AgentActivityProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<Map<string, AgentActivityInfo>>(new Map());
  const { activeTabId, focusedTarget } = useWorkspaceTargets();
  const browserFocused = useBrowserFocused();
  const [finished, setFinished] = useState<FinishedEntry[]>(loadFinishedEntries);
  const prevEntriesRef = useRef<Map<string, { serverName: string; target: string; label?: string; taskId?: number; projectId?: number; paneName?: string }>>(new Map());

  const fetchSnapshot = () => {
    api<AgentActivitySnapshotEntry[]>('/agent-activity')
      .then((snapshot) => setEntries(snapshotToMap(snapshot)))
      .catch(() => { /* WS events will still keep state converging */ });
  };

  useEffect(() => {
    fetchSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useNotificationChannel({
    onAgentActivity: (payload: AgentActivityPayload) => {
      setEntries((prev) => {
        const next = new Map(prev);
        const key = activityKey(payload.serverName, payload.target);
        if (payload.running) {
          next.set(key, {
            serverName: payload.serverName,
            target: payload.target,
            running: true,
            source: payload.source,
            taskId: payload.taskId,
            projectId: payload.projectId,
            label: payload.label,
            status: payload.status ?? 'working',
            paneName: payload.paneName,
          });
        } else {
          next.delete(key);
        }
        return next;
      });
    },
    onConnected: fetchSnapshot,
  });

  const isWatched = useCallback((serverName: string, target: string, _taskId: number | undefined): boolean => {
    if (!browserFocused) return false;
    const termPrefix = `terminal:${serverName}/${target}`;
    if (activeTabId === termPrefix || activeTabId?.startsWith(`${termPrefix}.`)) return true;
    if (focusedTarget === activityKey(serverName, target)) return true;
    return false;
  }, [browserFocused, activeTabId, focusedTarget]);

  // Detect running→stopped transitions and create finished entries
  useEffect(() => {
    const prev = prevEntriesRef.current;
    const stopped: FinishedEntry[] = [];
    for (const [key, info] of prev) {
      if (entries.has(key)) continue;
      if (isWatched(info.serverName, info.target, info.taskId)) continue;
      stopped.push({
        serverName: info.serverName,
        target: info.target,
        label: info.label,
        taskId: info.taskId,
        projectId: info.projectId,
        finishedAt: Date.now(),
        paneName: info.paneName,
      });
    }
    const resumedKeys = finished
      .map((e) => activityKey(e.serverName, e.target))
      .filter((key) => entries.has(key));
    if (stopped.length > 0 || resumedKeys.length > 0) {
      setFinished((cur) => {
        const next = cur.filter((e) => !entries.has(activityKey(e.serverName, e.target)));
        for (const s of stopped) {
          const key = activityKey(s.serverName, s.target);
          if (!next.some((e) => activityKey(e.serverName, e.target) === key)) next.push(s);
        }
        return next;
      });
    }
    const snapshot = new Map<string, { serverName: string; target: string; label?: string; taskId?: number; projectId?: number; paneName?: string }>();
    for (const [key, info] of entries) {
      snapshot.set(key, { serverName: info.serverName, target: info.target, label: info.label, taskId: info.taskId, projectId: info.projectId, paneName: info.paneName });
    }
    prevEntriesRef.current = snapshot;
  }, [entries, isWatched, finished]);

  // Auto-dismiss finished entries that become watched
  useEffect(() => {
    const watchedFinished = finished.filter((e) => isWatched(e.serverName, e.target, e.taskId));
    if (watchedFinished.length > 0) {
      setFinished((cur) => cur.filter((e) =>
        !watchedFinished.some((wf) => activityKey(wf.serverName, wf.target) === activityKey(e.serverName, e.target)),
      ));
    }
  }, [finished, isWatched]);

  useEffect(() => {
    saveFinishedEntries(finished);
  }, [finished]);

  const dismissFinished = useCallback((serverName: string, target: string) => {
    const key = activityKey(serverName, target);
    setFinished((cur) => cur.filter((e) => activityKey(e.serverName, e.target) !== key));
  }, []);

  const isRunning = (serverName: string, target: string): boolean =>
    entries.get(activityKey(serverName, target))?.running === true;

  const shouldShowActivity = (serverName: string, target: string): boolean => {
    const info = entries.get(activityKey(serverName, target));
    if (!info?.running) return false;
    return !isWatched(serverName, target, info.taskId);
  };

  const shouldShowTaskActivity = (taskId: number): boolean => {
    for (const info of entries.values()) {
      if (!info.running || info.taskId !== taskId) continue;
      if (!isWatched(info.serverName, info.target, info.taskId)) return true;
    }
    return false;
  };

  const windowIndicator = useCallback((serverName: string, target: string): ActivityIndicator => {
    const key = activityKey(serverName, target);
    const info = entries.get(key);
    if (info?.running && !isWatched(serverName, target, info.taskId)) {
      return info.status;
    }
    if (finished.some((e) => activityKey(e.serverName, e.target) === key)) {
      return 'finished';
    }
    return null;
  }, [entries, finished, isWatched]);

  return (
    <AgentActivityContext.Provider
      value={{
        entries,
        isRunning,
        shouldShowActivity,
        shouldShowTaskActivity,
        isWatched,
        windowIndicator,
        finishedEntries: finished,
        dismissFinished,
      }}
    >
      {children}
    </AgentActivityContext.Provider>
  );
}

export function useAgentActivity() {
  return useContext(AgentActivityContext);
}
