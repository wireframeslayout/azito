import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AgentActivityPayload } from '../types/notification';
import { findByWindowTarget } from '../utils/tmuxTarget';
import { useNotificationChannel } from './useNotificationChannel';
import { useWorkspaceTargets } from './useWorkspaceTargets';
import { reconcileProcessStatus, type ProcessStatusEntry } from './agentActivityProcessSync';

export interface AgentActivityInfo {
  serverName: string;
  target: string;
  running: boolean;
  /**
   * 'process' はどのソースにもない補完エントリ（Issue #338 フォロー）: hook/tui-supervisor の
   * 配線が無い手動起動ウィンドウでも、GET /api/windows/activity-status（プロセス実体検査ベース）が
   * 'working' と判定したものを補う。既存3ソースの実エントリが既にあるキーには決して被せない
   * （mergeProcessSupplement 参照）。
   */
  source: 'operation' | 'manual' | 'supervised' | 'process';
  taskId?: number;
  projectId?: number;
  label?: string;
  status: 'working' | 'blocked';
  paneName?: string;
}

/** GET /api/windows/activity-status の1件（WindowActivityStatusService、Issue #338 フォロー）。 */
interface WindowActivityStatusEntry {
  windowId: number;
  serverName: string;
  target: string;
  status: 'working' | 'idle' | 'offline';
  taskId?: number;
  projectId?: number;
  label?: string;
}

/** GET /api/windows/activity-status のポーリング間隔。サーバー側キャッシュ（60秒 TTL）に合わせる。 */
const PROCESS_STATUS_POLL_MS = 60_000;

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
  findFinished: (serverName: string, target: string) => FinishedEntry | undefined;
  dismissFinished: (serverName: string, target: string) => void;
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
  const [baseEntries, setEntries] = useState<Map<string, AgentActivityInfo>>(new Map());
  const { activeTabId, focusedTarget } = useWorkspaceTargets();
  const browserFocused = useBrowserFocused();
  const [finished, setFinished] = useState<FinishedEntry[]>(loadFinishedEntries);
  const prevEntriesRef = useRef<Map<string, { serverName: string; target: string; label?: string; taskId?: number; projectId?: number; paneName?: string }>>(new Map());
  // fetchProcessStatus (below) needs the *current* finished list to avoid double-counting a
  // transition the hook already recorded, but it's set up once (empty deps, matching the
  // pre-existing polling interval lifecycle) — a ref keeps it read-current without re-creating
  // the interval on every `finished` change.
  const finishedRef = useRef<FinishedEntry[]>(finished);
  useEffect(() => {
    finishedRef.current = finished;
  }, [finished]);

  const fetchSnapshot = () => {
    api<AgentActivitySnapshotEntry[]>('/agent-activity')
      .then((snapshot) => setEntries(snapshotToMap(snapshot)))
      .catch(() => { /* WS events will still keep state converging */ });
  };

  useEffect(() => {
    fetchSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // プロセス実体検査ベースの補完（Issue #338 フォロー）: hook/tui-supervisor が接続していない
  // 手動起動ウィンドウでも「working」を拾えるよう、/api/windows/activity-status を並行してポーリング
  // する。既存の AgentActivityMonitor（/api/agent-activity、通知配信を伴う）の挙動には一切触れず、
  // baseEntries に無いキーだけを補う（下記 entries の useMemo 参照）。
  const [processEntries, setProcessEntries] = useState<Map<string, AgentActivityInfo>>(new Map());
  // Previous poll's reconciled "working" set (Issue #338 T12), owned by reconcileProcessStatus's
  // caller per its contract — carries the process-liveness history across polls so a
  // working -> idle/offline transition can be derived even for windows the hook never covers
  // (see agentActivityProcessSync.ts for why this exists).
  const prevProcessWorkingRef = useRef<Map<string, ProcessStatusEntry>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const fetchProcessStatus = () => {
      api<WindowActivityStatusEntry[]>('/windows/activity-status')
        .then((list) => {
          if (cancelled) return;
          const existingFinishedKeys = new Set(finishedRef.current.map((e) => activityKey(e.serverName, e.target)));
          const { workingByKey, newlyFinished } = reconcileProcessStatus(
            list,
            prevProcessWorkingRef.current,
            existingFinishedKeys,
          );
          prevProcessWorkingRef.current = workingByKey;

          const map = new Map<string, AgentActivityInfo>();
          for (const [key, e] of workingByKey) {
            map.set(key, {
              serverName: e.serverName,
              target: e.target,
              running: true,
              source: 'process',
              taskId: e.taskId,
              projectId: e.projectId,
              label: e.label,
              status: 'working',
            });
          }
          setProcessEntries(map);

          if (newlyFinished.length > 0) {
            setFinished((cur) => {
              const next = [...cur];
              for (const f of newlyFinished) {
                const key = activityKey(f.serverName, f.target);
                if (next.some((e) => activityKey(e.serverName, e.target) === key)) continue;
                next.push({ ...f, finishedAt: Date.now() });
              }
              return next;
            });
          }
        })
        .catch(() => { /* best-effort supplement; base entries remain authoritative */ });
    };
    fetchProcessStatus();
    const interval = setInterval(fetchProcessStatus, PROCESS_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // baseEntries（AgentActivityMonitor 由来、hook/notification で即時更新）を常に優先し、
  // processEntries はそこに存在しないキーだけを補う純粋な追加専用マージ。baseEntries 側の
  // 状態（blocked 等）を上書き・削除することは無い。
  const entries = useMemo(() => {
    if (processEntries.size === 0) return baseEntries;
    const merged = new Map(baseEntries);
    for (const [key, info] of processEntries) {
      if (!merged.has(key)) merged.set(key, info);
    }
    return merged;
  }, [baseEntries, processEntries]);

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

  // Raw entry lookup normalized against pane-suffix variance: `entries` keys targets exactly
  // as reported by the activity source (pane suffix already stripped server-side), while
  // callers (e.g. a window's `tmuxTarget`) may carry a `.<paneIndex>` suffix.
  const findEntry = useCallback((serverName: string, target: string): AgentActivityInfo | undefined =>
    findByWindowTarget(entries.values(), serverName, target), [entries]);

  const findFinished = useCallback((serverName: string, target: string): FinishedEntry | undefined =>
    findByWindowTarget(finished, serverName, target), [finished]);

  const isRunning = (serverName: string, target: string): boolean =>
    findEntry(serverName, target)?.running === true;

  const activityStatus = (serverName: string, target: string): 'working' | 'blocked' | null => {
    const info = findEntry(serverName, target);
    return info?.running ? info.status : null;
  };

  const shouldShowActivity = (serverName: string, target: string): boolean => {
    const info = findEntry(serverName, target);
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
    const info = findEntry(serverName, target);
    if (info?.running && !isWatched(serverName, target, info.taskId)) {
      return info.status;
    }
    if (findFinished(serverName, target)) {
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
      }}
    >
      {children}
    </AgentActivityContext.Provider>
  );
}

export function useAgentActivity() {
  return useContext(AgentActivityContext);
}
