import { useState } from 'react';
import { readWindowViewMode, resolveWindowViewMode, writeWindowViewMode, type WindowViewMode } from '../lib/windowViewMode';

export function useWindowViewMode(windowId: number | null, isMobile: boolean, isAgent: boolean): [WindowViewMode, (mode: WindowViewMode, targetId: number | null) => void] {
  const [selections, setSelections] = useState<Map<number, WindowViewMode>>(() => new Map());
  const selection = windowId === null ? null : selections.get(windowId) ?? readWindowViewMode(windowId);
  const mode = resolveWindowViewMode(windowId, selection, isMobile, isAgent);
  function selectMode(next: WindowViewMode, targetId: number | null): void {
    if (targetId === null) return;
    writeWindowViewMode(targetId, next);
    setSelections((previous) => new Map(previous).set(targetId, next));
  }
  return [mode, selectMode];
}
