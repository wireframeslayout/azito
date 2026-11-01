export type WindowViewMode = 'terminal' | 'chat';

export function viewModeStorageKey(windowId: number): string {
  return `azito.windowView.${windowId}`;
}

export function readWindowViewMode(windowId: number): WindowViewMode | null {
  try {
    const value = localStorage.getItem(viewModeStorageKey(windowId));
    return value === 'terminal' || value === 'chat' ? value : null;
  } catch { return null; }
}

export function writeWindowViewMode(windowId: number, mode: WindowViewMode): void {
  try { localStorage.setItem(viewModeStorageKey(windowId), mode); } catch { /* Selection remains in memory. */ }
}

export function isAgentWindow(windowId: number | null, windowType: string | undefined, entries: Iterable<{ windowId?: number | null }>): boolean {
  return windowId !== null && (windowType === 'agent' || Array.from(entries).some((entry) => entry.windowId === windowId));
}

export function resolveWindowViewMode(windowId: number | null, selection: WindowViewMode | null, isMobile: boolean, isAgent: boolean): WindowViewMode {
  if (windowId === null) return 'terminal';
  return selection ?? (isMobile && isAgent ? 'chat' : 'terminal');
}
