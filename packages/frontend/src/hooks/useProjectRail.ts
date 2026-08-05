import { useCallback, useSyncExternalStore } from 'react';

const PINNED_KEY = 'project-rail-pinned';
const RECENT_KEY = 'project-rail-recent';
const RECENT_LIMIT = 20;
const VISIBLE_LIMIT = 6;

export interface RailProject {
  id: number;
  name: string;
  icon?: string | null;
  color?: string | null;
  isPinned: boolean;
}

type ProjectInput = { id: number; name: string; icon?: string | null; color?: string | null };

export interface UseProjectRailReturn {
  pin: (projectId: number) => void;
  unpin: (projectId: number) => void;
  touch: (projectId: number) => void;
  /** Full pinned id list in manual display order (not truncated to the visible-rail limit). */
  pinnedIds: number[];
  movePinned: (projectId: number, direction: 'up' | 'down') => void;
  /** Moves `sourceId` next to `targetId` within the full pinned set (used by DnD drop). */
  movePinnedTo: (sourceId: number, targetId: number, position: 'before' | 'after') => void;
  /**
   * Drops pinned/recent ids that no longer correspond to a real project (e.g. the project was
   * deleted). Callers must only pass a `projectIds` list that reflects a confirmed, fully loaded
   * project set — never an empty array from an in-flight or failed fetch, or every pin gets
   * wiped on the next call.
   */
  normalize: (projectIds: number[]) => void;
  getVisibleProjects: (allProjects: ProjectInput[]) => RailProject[];
  getAllSortedProjects: (allProjects: ProjectInput[]) => RailProject[];
  isPinned: (projectId: number) => boolean;
}

function readIds(key: string): number[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is number => Number.isInteger(value));
  } catch {
    localStorage.removeItem(key);
    return [];
  }
}

function writeIds(key: string, ids: number[]) {
  localStorage.setItem(key, JSON.stringify(ids));
}

// 存在しないプロジェクトID（削除済み等）と重複を取り除く。境界判定・並べ替えは常にこの正規化後のリストを基準にする。
function normalizeIds(ids: number[], validIds: Set<number>): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const id of ids) {
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function idsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sortProjects(allProjects: ProjectInput[], pinned: number[], recent: number[]): RailProject[] {
  const byId = new Map(allProjects.map((project) => [project.id, project]));
  const seen = new Set<number>();
  const ordered: RailProject[] = [];

  const pushProject = (id: number, isPinned: boolean) => {
    const project = byId.get(id);
    if (!project || seen.has(id)) return;
    seen.add(id);
    ordered.push({ ...project, isPinned });
  };

  pinned.forEach((id) => pushProject(id, true));
  recent.forEach((id) => {
    if (!pinned.includes(id)) pushProject(id, false);
  });
  allProjects.forEach((project) => pushProject(project.id, pinned.includes(project.id)));

  return ordered;
}

// ── モジュールスコープの共有ストア ──
// ProjectSidebar（デスクトップレール）と MobileProjectSheet/ProjectSearchPopover は、それぞれ
// 独立に useProjectRail() を呼ぶ。同一タブ内では localStorage の 'storage' イベントは発火しないため、
// pinned/recent をコンポーネントローカルな useState で持つと、一方での並べ替えがもう一方の表示に
// 反映されない。そこで state をモジュール変数として一元管理し、全インスタンスが
// useSyncExternalStore で同じスナップショットを購読・更新する。永続化もここに一元化する。
interface RailState {
  pinned: number[];
  recent: number[];
}

let storeState: RailState = {
  pinned: readIds(PINNED_KEY),
  recent: readIds(RECENT_KEY),
};

const listeners = new Set<() => void>();

function getSnapshot(): RailState {
  return storeState;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: RailState) {
  storeState = next;
  listeners.forEach((listener) => listener());
}

function updatePinned(updater: (prev: number[]) => number[]) {
  const next = updater(storeState.pinned);
  if (next === storeState.pinned) return;
  writeIds(PINNED_KEY, next);
  commit({ ...storeState, pinned: next });
}

function updateRecent(updater: (prev: number[]) => number[]) {
  const next = updater(storeState.recent);
  if (next === storeState.recent) return;
  writeIds(RECENT_KEY, next);
  commit({ ...storeState, recent: next });
}

function normalizeStore(projectIds: number[]) {
  const validIds = new Set(projectIds);
  const nextPinned = normalizeIds(storeState.pinned, validIds);
  const nextRecent = normalizeIds(storeState.recent, validIds);
  const pinnedChanged = !idsEqual(nextPinned, storeState.pinned);
  const recentChanged = !idsEqual(nextRecent, storeState.recent);
  if (!pinnedChanged && !recentChanged) return;
  if (pinnedChanged) writeIds(PINNED_KEY, nextPinned);
  if (recentChanged) writeIds(RECENT_KEY, nextRecent);
  commit({
    pinned: pinnedChanged ? nextPinned : storeState.pinned,
    recent: recentChanged ? nextRecent : storeState.recent,
  });
}

export function useProjectRail(): UseProjectRailReturn {
  const { pinned, recent } = useSyncExternalStore(subscribe, getSnapshot);

  const pin = useCallback((projectId: number) => {
    updatePinned((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
  }, []);

  const unpin = useCallback((projectId: number) => {
    updatePinned((prev) => prev.filter((id) => id !== projectId));
  }, []);

  const touch = useCallback((projectId: number) => {
    updateRecent((prev) => [projectId, ...prev.filter((id) => id !== projectId)].slice(0, RECENT_LIMIT));
  }, []);

  const movePinnedTo = useCallback((sourceId: number, targetId: number, position: 'before' | 'after') => {
    updatePinned((prev) => {
      if (sourceId === targetId || !prev.includes(sourceId) || !prev.includes(targetId)) return prev;
      const withoutSource = prev.filter((id) => id !== sourceId);
      let insertAt = withoutSource.indexOf(targetId);
      if (insertAt === -1) return prev;
      if (position === 'after') insertAt += 1;
      withoutSource.splice(insertAt, 0, sourceId);
      return withoutSource;
    });
  }, []);

  const movePinned = useCallback((projectId: number, direction: 'up' | 'down') => {
    updatePinned((prev) => {
      const fromIndex = prev.indexOf(projectId);
      if (fromIndex === -1) return prev;
      const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
      if (toIndex < 0 || toIndex >= prev.length) return prev;
      const next = [...prev];
      [next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]];
      return next;
    });
  }, []);

  const normalize = useCallback((projectIds: number[]) => {
    normalizeStore(projectIds);
  }, []);

  const getAllSortedProjects = useCallback((allProjects: ProjectInput[]) => {
    return sortProjects(allProjects, pinned, recent);
  }, [pinned, recent]);

  const getVisibleProjects = useCallback((allProjects: ProjectInput[]) => {
    return sortProjects(allProjects, pinned, recent).slice(0, VISIBLE_LIMIT);
  }, [pinned, recent]);

  const isPinned = useCallback((projectId: number) => pinned.includes(projectId), [pinned]);

  return { pin, unpin, touch, pinnedIds: pinned, movePinned, movePinnedTo, normalize, getVisibleProjects, getAllSortedProjects, isPinned };
}
