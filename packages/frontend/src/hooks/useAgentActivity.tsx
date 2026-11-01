import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AgentActivityPayload } from '../types/notification';
import { stripPaneSuffix } from '@azito/shared';
import { isWatchedWindow } from '../lib/isWatched';
import { loadFinishedRetention, saveFinishedRetention, type FinishedRetentionSettings } from '../lib/finishedRetentionSettings';
import { useNotificationChannel } from './useNotificationChannel';
import { useWorkspaceTargets } from './useWorkspaceTargets';
import {
  activityKey,
  activityKeyForEntry,
  pruneFinished,
  markSeen,
  removeDeletedFinished,
  upsertFinished,
  mergeFinishedEntry,
  type FinishedEntry,
} from '../lib/finishedWindows';

// 完了行のキー規約・寿命・リスト操作は lib/finishedWindows.ts に集約してある（純関数としてテスト
// されている）。ここからの re-export は既存の import 経路（useActiveWindowRows 等）を保つため。
export { activityKey, activityKeyForEntry };
export type { FinishedEntry };

export interface AgentActivityInfo {
  serverName: string;
  target: string;
  running: boolean;
  source: 'operation' | 'manual' | 'supervised';
  taskId?: number;
  windowId?: number;
  projectId?: number;
  label?: string;
  labelSource?: 'auto' | 'user';
  taskTitle?: string;
  workerType?: string;
  windowType?: string;
  paneTitle?: string;
  paneCommand?: string;
  status: 'working' | 'blocked';
  paneName?: string;
}

interface AgentActivitySnapshotEntry {
  serverName: string;
  target: string;
  running: boolean;
  source: 'operation' | 'manual' | 'supervised';
  taskId?: number;
  windowId?: number;
  projectId?: number;
  label?: string;
  labelSource?: 'auto' | 'user';
  taskTitle?: string;
  workerType?: string;
  windowType?: string;
  paneTitle?: string;
  paneCommand?: string;
  status?: 'working' | 'blocked';
  paneName?: string;
}

export type ActivityIndicator = 'working' | 'blocked' | 'finished' | null;

interface AgentActivityContextValue {
  entries: Map<string, AgentActivityInfo>;
  isRunning: (serverName: string, target: string) => boolean;
  shouldShowActivity: (serverName: string, target: string) => boolean;
  shouldShowTaskActivity: (taskId: number) => boolean;
  isWatched: (serverName: string, target: string, windowId?: number) => boolean;
  windowIndicator: (serverName: string, target: string) => ActivityIndicator;
  /**
   * Raw running/blocked status, with no "currently watched window" suppression and with
   * pane-suffix-normalized target matching (`session:window` vs `session:window.1`).
   * Use this for status classification (active/idle); use `windowIndicator` only for the
   * per-row visual indicator, which intentionally suppresses the currently focused window.
   */
  activityStatus: (serverName: string, target: string) => 'working' | 'blocked' | null;
  finishedEntries: FinishedEntry[];
  /**
   * ペインサフィックス正規化込みで finished エントリを引く（`findByWindowTarget`）。
   * `finishedEntries` を呼び出し側で生キー完全一致 find すると、ペインサフィックス付きの
   * タスクウィンドウ（`session:win.1`）が引けないため、完了表示の照合は必ずこれを使う。
   */
  findFinished: (serverName: string, target: string, windowId?: number) => FinishedEntry | undefined;
  retention: FinishedRetentionSettings;
  setRetention: (settings: FinishedRetentionSettings) => void;
  markFinishedSeen: (serverName: string, target: string, windowId?: number) => void;
  markAllFinishedSeen: () => void;
  clearSeenFinished: () => void;
  dismissFinished: (serverName: string, target: string, windowId?: number) => void;
}

const AgentActivityContext = createContext<AgentActivityContextValue>({
  entries: new Map(),
  isRunning: () => false,
  shouldShowActivity: () => false,
  shouldShowTaskActivity: () => false,
  isWatched: () => false,
  windowIndicator: () => null,
  activityStatus: () => null,
  finishedEntries: [],
  findFinished: () => undefined,
  retention: { maxCount: 10, retentionMs: 3600000 },
  setRetention: () => {},
  markFinishedSeen: () => {},
  markAllFinishedSeen: () => {},
  clearSeenFinished: () => {},
  dismissFinished: () => {},
});

export function snapshotToMap(snapshot: AgentActivitySnapshotEntry[]): Map<string, AgentActivityInfo> {
  const map = new Map<string, AgentActivityInfo>();
  for (const entry of snapshot) applyActivity(map, entry);
  return map;
}

function applyActivity(map: Map<string, AgentActivityInfo>, payload: AgentActivitySnapshotEntry): void {
  const key = activityKey(payload.serverName, payload.target, payload.windowId);
  if (!payload.running) {
    map.delete(key);
    return;
  }
  map.set(key, {
    serverName: payload.serverName,
    target: payload.target,
    running: true,
    source: payload.source,
    taskId: payload.taskId,
    windowId: payload.windowId,
    projectId: payload.projectId,
    label: payload.label,
    labelSource: payload.labelSource,
    taskTitle: payload.taskTitle,
    workerType: payload.workerType,
    windowType: payload.windowType,
    paneTitle: payload.paneTitle,
    paneCommand: payload.paneCommand,
    status: payload.status ?? 'working',
    paneName: payload.paneName,
  });
}

/** One event applied to a copy of `entries`, with the entry it replaced (used to keep a finished row's title). */
export function transitionActivityEntries(
  entries: Map<string, AgentActivityInfo>, payload: AgentActivityPayload,
): { entries: Map<string, AgentActivityInfo>; previous?: AgentActivityInfo } {
  const previous = entries.get(activityKey(payload.serverName, payload.target, payload.windowId));
  const next = new Map(entries);
  applyActivity(next, payload);
  return { entries: next, previous };
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

/** TTL の定期掃除間隔（タブを開きっぱなしでも完了行が寿命を超えて残らないようにする）。 */
const FINISHED_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

function loadFinishedEntries(settings: FinishedRetentionSettings): FinishedEntry[] {
  try {
    const raw = localStorage.getItem(FINISHED_STORAGE_KEY);
    if (!raw) return [];
    const json = JSON.parse(raw);
    const parsed: unknown[] = Array.isArray(json) ? json : [];
    const valid = parsed.filter((e): e is FinishedEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as FinishedEntry).serverName === 'string' &&
      typeof (e as FinishedEntry).target === 'string' &&
      typeof (e as FinishedEntry).finishedAt === 'number' && Number.isFinite((e as FinishedEntry).finishedAt) &&
      ((e as FinishedEntry).seenAt == null || (typeof (e as FinishedEntry).seenAt === 'number' && Number.isFinite((e as FinishedEntry).seenAt))),
    );
    return pruneFinished(valid, Date.now(), settings);
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
  // 稼働状態の単一ソース: GET /api/agent-activity のスナップショット＋`agent:activity` WS イベント。
  // 優先順位の調停（supervisor > hook > ペイン分類 > process/transcript）はすべてサーバー側の
  // AgentActivityMonitor が行う。完了表示には最後の表示メタデータを保持する。
  const [entries, setEntries] = useState<Map<string, AgentActivityInfo>>(new Map());
  const entriesRef = useRef(entries);
  const { activeTabId, focusedTarget } = useWorkspaceTargets();
  const browserFocused = useBrowserFocused();
  const [retention, setRetentionState] = useState(loadFinishedRetention);
  const [finished, setFinished] = useState<FinishedEntry[]>(() => loadFinishedEntries(retention));
  const setRetention = useCallback((settings: FinishedRetentionSettings) => {
    setRetentionState(settings);
    saveFinishedRetention(settings);
    setFinished((cur) => pruneFinished(cur, Date.now(), settings));
  }, []);

  // WS ハンドラは ref 経由で最新の isWatched を読む（ハンドラ自体は購読時に固定されるため）。
  const isWatchedRef = useRef<(serverName: string, target: string, windowId?: number) => boolean>(() => false);

  const snapshotGeneration = useRef(0);
  const pendingEvents = useRef<AgentActivityPayload[] | null>(null);

  const fetchSnapshot = () => {
    const generation = ++snapshotGeneration.current;
    pendingEvents.current = [];
    api<AgentActivitySnapshotEntry[]>('/agent-activity')
      .then((snapshot) => {
        if (generation !== snapshotGeneration.current) return;
        const next = snapshotToMap(snapshot);
        for (const event of pendingEvents.current ?? []) applyActivity(next, event);
        pendingEvents.current = null;
        entriesRef.current = next;
        setEntries(next);
      })
      .catch(() => {
        if (generation === snapshotGeneration.current) pendingEvents.current = null;
      });
  };

  useEffect(() => {
    fetchSnapshot();
    return () => {
      snapshotGeneration.current++;
      pendingEvents.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useNotificationChannel({
    onAgentActivity: (payload: AgentActivityPayload) => {
      pendingEvents.current?.push(payload);
      const { entries: next, previous } = transitionActivityEntries(entriesRef.current, payload);
      entriesRef.current = next;
      setEntries(next);
      if (payload.running) return;

      if (payload.reason === 'deleted') {
        setFinished((cur) => removeDeletedFinished(cur, payload));
        return;
      }
      if (payload.reason !== 'completed') return;
      const seenAt = isWatchedRef.current(payload.serverName, payload.target, payload.windowId) ? Date.now() : undefined;
      setFinished((cur) => upsertFinished(cur, mergeFinishedEntry({
        serverName: payload.serverName,
        target: payload.target,
        windowId: payload.windowId,
        label: payload.label,
        labelSource: payload.labelSource,
        taskTitle: payload.taskTitle,
        workerType: payload.workerType,
        windowType: payload.windowType,
        paneTitle: payload.paneTitle,
        paneCommand: payload.paneCommand,
        taskId: payload.taskId,
        projectId: payload.projectId,
        finishedAt: Date.now(),
        seenAt,
        paneName: payload.paneName,
      }, previous)));
    },
    onConnected: fetchSnapshot,
  });

  const isWatched = useCallback((serverName: string, target: string, windowId?: number): boolean => {
    return isWatchedWindow(browserFocused, activeTabId, focusedTarget, serverName, target, windowId);
  }, [browserFocused, activeTabId, focusedTarget]);
  isWatchedRef.current = isWatched;

  useEffect(() => {
    if (!finished.some((e) => entries.has(activityKeyForEntry(e)))) return;
    setFinished((cur) => cur.filter((e) => !entries.has(activityKeyForEntry(e))));
  }, [entries, finished]);

  // TTL の定期適用。読み込み時（loadFinishedEntries）と保存時（下の effect）にも同じ規則が効く。
  useEffect(() => {
    const timer = setInterval(() => {
      setFinished((cur) => pruneFinished(cur, Date.now(), retention));
    }, FINISHED_PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [retention]);

  useEffect(() => {
    setFinished((cur) => {
      const now = Date.now();
      return pruneFinished(markSeen(cur, now, (e) => isWatched(e.serverName, e.target, e.windowId)), now, retention);
    });
  }, [finished, isWatched, retention]);

  useEffect(() => {
    const pruned = pruneFinished(finished, Date.now(), retention);
    saveFinishedEntries(pruned);
    if (pruned !== finished) setFinished(pruned);
  }, [finished, retention]);

  const markFinishedSeen = useCallback((serverName: string, target: string, windowId?: number) => {
    const key = activityKey(serverName, target, windowId);
    setFinished((cur) => pruneFinished(markSeen(cur, Date.now(), (e) => activityKeyForEntry(e) === key), Date.now(), retention));
  }, [retention]);
  const markAllFinishedSeen = useCallback(() => {
    const now = Date.now();
    setFinished((cur) => pruneFinished(markSeen(cur, now, () => true), now, retention));
  }, [retention]);
  const clearSeenFinished = useCallback(() => setFinished((cur) => cur.filter((e) => e.seenAt == null)), []);
  const dismissFinished = useCallback((serverName: string, target: string, windowId?: number) => {
    const key = activityKey(serverName, target, windowId);
    setFinished((cur) => cur.filter((e) => activityKeyForEntry(e) !== key));
  }, []);

  const findEntry = useCallback((serverName: string, target: string, windowId?: number): AgentActivityInfo | undefined => {
    if (windowId != null) {
      for (const e of entries.values()) {
        if (e.windowId === windowId) return e;
      }
    }
    const normalized = stripPaneSuffix(target);
    for (const e of entries.values()) {
      if (e.serverName === serverName && stripPaneSuffix(e.target) === normalized) return e;
    }
    return undefined;
  }, [entries]);

  const findFinished = useCallback((serverName: string, target: string, windowId?: number): FinishedEntry | undefined => {
    if (windowId != null) {
      return finished.find((e) => e.windowId === windowId);
    }
    const normalized = stripPaneSuffix(target);
    return finished.find((e) => e.serverName === serverName && stripPaneSuffix(e.target) === normalized);
  }, [finished]);

  const isRunning = (serverName: string, target: string): boolean =>
    findEntry(serverName, target)?.running === true;

  const activityStatus = (serverName: string, target: string): 'working' | 'blocked' | null => {
    const info = findEntry(serverName, target);
    return info?.running ? info.status : null;
  };

  const shouldShowActivity = (serverName: string, target: string): boolean => {
    const info = findEntry(serverName, target);
    if (!info?.running) return false;
    return !isWatched(serverName, target, info.windowId);
  };

  const shouldShowTaskActivity = (taskId: number): boolean => {
    for (const info of entries.values()) {
      if (!info.running || info.taskId !== taskId) continue;
      if (!isWatched(info.serverName, info.target, info.windowId)) return true;
    }
    return false;
  };

  const windowIndicator = useCallback((serverName: string, target: string): ActivityIndicator => {
    const info = findEntry(serverName, target);
    if (info?.running && !isWatched(serverName, target, info.windowId)) {
      return info.status;
    }
    const finishedEntry = findFinished(serverName, target);
    if (finishedEntry && finishedEntry.seenAt == null) {
      return 'finished';
    }
    return null;
  }, [findEntry, findFinished, isWatched]);

  return (
    <AgentActivityContext.Provider
      value={{
        entries,
        isRunning,
        shouldShowActivity,
        shouldShowTaskActivity,
        isWatched,
        windowIndicator,
        activityStatus,
        finishedEntries: finished,
        findFinished,
        dismissFinished,
        retention, setRetention, markFinishedSeen, markAllFinishedSeen, clearSeenFinished,
      }}
    >
      {children}
    </AgentActivityContext.Provider>
  );
}

export function useAgentActivity() {
  return useContext(AgentActivityContext);
}
