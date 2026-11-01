import { useSyncExternalStore } from 'react';
import { readWindowViewMode, resolveWindowViewMode, writeWindowViewMode, type WindowViewMode } from '../lib/windowViewMode';

// Shared by the task panel and its terminal containers when the layout changes.
const selections = new Map<number, WindowViewMode>();
const listeners = new Set<() => void>();
let revision = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getRevision(): number { return revision; }

export function useWindowViewMode(windowId: number | null, isMobile: boolean, isAgent: boolean): [WindowViewMode, (mode: WindowViewMode, targetId: number | null) => void] {
  useSyncExternalStore(subscribe, getRevision);
  const selection = windowId === null ? null : selections.get(windowId) ?? readWindowViewMode(windowId);
  const mode = resolveWindowViewMode(windowId, selection, isMobile, isAgent);
  function selectMode(next: WindowViewMode, targetId: number | null): void {
    if (targetId === null) return;
    writeWindowViewMode(targetId, next);
    selections.set(targetId, next);
    revision += 1;
    listeners.forEach((listener) => listener());
  }
  return [mode, selectMode];
}
