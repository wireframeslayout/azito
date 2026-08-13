import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AgentActivityPayload } from '../types/notification';
import { findByWindowTarget } from '../utils/tmuxTarget';
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

/**
 * 完了行の寿命。Provider が唯一の適用箇所（読み込み時・定期・保存時）で、表示側は
 * prune 済みのデータをそのまま出す。以前は SPバーの表示フィルタだけが1時間で切っており、
 * 実体（localStorage）は無期限に積み上がっていた。
 */
export const FINISHED_TTL_MS = 60 * 60 * 1000;

/** TTL の定期掃除間隔（タブを開きっぱなしでも完了行が寿命を超えて残らないようにする）。 */
const FINISHED_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/** TTL を過ぎた完了行を落とす。長さが変わらなければ同一参照を返す（再レンダリング抑止）。 */
function pruneFinished(entries: FinishedEntry[], now: number): FinishedEntry[] {
  const kept = entries.filter((e) => now - e.finishedAt < FINISHED_TTL_MS);
  return kept.length === entries.length ? entries : kept;
}

function loadFinishedEntries(): FinishedEntry[] {
  try {
    const raw = localStorage.getItem(FINISHED_STORAGE_KEY);
    if (!raw) return [];
    const json = JSON.parse(raw);
    const parsed: unknown[] = Array.isArray(json) ? json : [];
    const valid = parsed.filter((e): e is FinishedEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as FinishedEntry).serverName === 'string' &&
      typeof (e as FinishedEntry).target === 'string' &&
      typeof (e as FinishedEntry).finishedAt === 'number',
    );
    return pruneFinished(valid, Date.now());
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
  // AgentActivityMonitor が行うため、ここには合成・補完ロジックを一切置かない。
  const [entries, setEntries] = useState<Map<string, AgentActivityInfo>>(new Map());
  const { activeTabId, focusedTarget } = useWorkspaceTargets();
  const browserFocused = useBrowserFocused();
  const [finished, setFinished] = useState<FinishedEntry[]>(loadFinishedEntries);

  // WS ハンドラは ref 経由で最新の isWatched を読む（ハンドラ自体は購読時に固定されるため）。
  const isWatchedRef = useRef<(serverName: string, target: string, taskId: number | undefined) => boolean>(() => false);

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
      const key = activityKey(payload.serverName, payload.target);
      setEntries((prev) => {
        const next = new Map(prev);
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
      if (payload.running) return;

      // 完了行のライフサイクルは遷移の reason だけで決まる（P3）。
      // - 'completed' のみが完了行を生む。中断・ウィンドウ削除・プロセス消滅・判定不能は生まない
      //   （これらを一律「完了」にしていたのが、リスポーンやハブ再起動で偽の完了行が鋳造される原因だった）。
      // - 'deleted' は該当キーの完了行を即時に取り除く（実体の無いウィンドウの幽霊行を残さない）。
      if (payload.reason === 'deleted') {
        setFinished((cur) => cur.filter((e) => activityKey(e.serverName, e.target) !== key));
        return;
      }
      if (payload.reason !== 'completed') return;
      if (isWatchedRef.current(payload.serverName, payload.target, payload.taskId)) return;
      setFinished((cur) => {
        if (cur.some((e) => activityKey(e.serverName, e.target) === key)) return cur;
        return [...cur, {
          serverName: payload.serverName,
          target: payload.target,
          label: payload.label,
          taskId: payload.taskId,
          projectId: payload.projectId,
          finishedAt: Date.now(),
          paneName: payload.paneName,
        }];
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
  isWatchedRef.current = isWatched;

  // 再稼働したキーの完了行は落とす（同じウィンドウが「稼働中」と「完了」に二重表示されない）。
  useEffect(() => {
    if (!finished.some((e) => entries.has(activityKey(e.serverName, e.target)))) return;
    setFinished((cur) => cur.filter((e) => !entries.has(activityKey(e.serverName, e.target))));
  }, [entries, finished]);

  // TTL の定期適用。読み込み時（loadFinishedEntries）と保存時（下の effect）にも同じ規則が効く。
  useEffect(() => {
    const timer = setInterval(() => {
      setFinished((cur) => pruneFinished(cur, Date.now()));
    }, FINISHED_PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

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
    saveFinishedEntries(pruneFinished(finished, Date.now()));
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
