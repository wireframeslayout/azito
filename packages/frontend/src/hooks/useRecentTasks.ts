import { useCallback, useSyncExternalStore } from 'react';

const OPENED_AT_KEY = 'tasks-sidebar-opened-at';
const MAX_ENTRIES = 50;

export interface UseRecentTasksReturn {
  /** taskId -> epoch ms of the last time the task was opened in the UI. */
  openedAt: Record<number, number>;
  recordOpened: (taskId: number) => void;
}

function readOpenedAt(): Record<number, number> {
  const raw = localStorage.getItem(OPENED_AT_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<number, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const id = Number(key);
      if (Number.isInteger(id) && typeof value === 'number' && Number.isFinite(value)) {
        result[id] = value;
      }
    }
    return result;
  } catch {
    localStorage.removeItem(OPENED_AT_KEY);
    return {};
  }
}

function writeOpenedAt(map: Record<number, number>) {
  localStorage.setItem(OPENED_AT_KEY, JSON.stringify(map));
}

// 保持件数の上限を超えたら古いものから間引く。
function capEntries(map: Record<number, number>): Record<number, number> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return map;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

// ── モジュールスコープの共有ストア ──
// useProjectRail と同じ理由: TasksSidebar（並べ替えのため openedAt を読む）と
// Workspace（タスクを開いた箇所で recordOpened を呼ぶ）は別コンポーネントから
// それぞれ独立に useRecentTasks() を呼ぶ。state をモジュール変数として一元管理し、
// 全インスタンスが useSyncExternalStore で同じスナップショットを購読する。
let storeState: Record<number, number> = readOpenedAt();

const listeners = new Set<() => void>();

function getSnapshot(): Record<number, number> {
  return storeState;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: Record<number, number>) {
  storeState = next;
  listeners.forEach((listener) => listener());
}

function recordOpenedInStore(taskId: number) {
  const next = capEntries({ ...storeState, [taskId]: Date.now() });
  writeOpenedAt(next);
  commit(next);
}

export function useRecentTasks(): UseRecentTasksReturn {
  const openedAt = useSyncExternalStore(subscribe, getSnapshot);

  const recordOpened = useCallback((taskId: number) => {
    recordOpenedInStore(taskId);
  }, []);

  return { openedAt, recordOpened };
}
