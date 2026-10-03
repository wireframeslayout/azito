import { terminalTabId, terminalRefDisplayLabel, type TerminalRef } from './terminalRef';
import type { Session } from '../pages/workspace/types';

interface TerminalTabLike {
  id: string;
  type: string;
  label: string;
  target?: string;
  terminalRef?: TerminalRef;
  reconnectKey?: number;
}

export interface TabsState<T extends TerminalTabLike> {
  tabs: T[];
  activeTabId: string | null;
}

/**
 * Re-points `oldTabId` at `newRef`. When another tab already has the new id, the old tab is
 * dropped and that one is kept (and reconnected) instead of leaving two tabs with the same id.
 */
export function applyRetargetTab<T extends TerminalTabLike>(state: TabsState<T>, oldTabId: string, newRef: TerminalRef): TabsState<T> {
  const newTabId = terminalTabId(newRef);
  const duplicate = newTabId !== oldTabId && state.tabs.some((t) => t.id === newTabId);
  const activeTabId = state.activeTabId === oldTabId ? newTabId : state.activeTabId;
  if (duplicate) {
    return {
      tabs: state.tabs
        .filter((t) => t.id !== oldTabId)
        .map((t) => (t.id === newTabId ? { ...t, reconnectKey: (t.reconnectKey ?? 0) + 1 } : t)),
      activeTabId,
    };
  }
  const target = newRef.kind === 'windowId' ? `w${newRef.windowId}` : newRef.ref;
  return {
    tabs: state.tabs.map((t) => (t.id === oldTabId
      ? { ...t, id: newTabId, target, label: terminalRefDisplayLabel(newRef), terminalRef: newRef }
      : t)),
    activeTabId,
  };
}

/** The open terminal tab showing window `windowId` (any pane, windowId or ref form), if any. */
export function findWindowTerminalTab<T extends TerminalTabLike>(tabs: T[], serverName: string, windowId: number, sessions: Session[] | undefined): T | undefined {
  const windowRef = sessions?.flatMap((s) => s.windows).find((w) => w.windowId === windowId)?.ref;
  return tabs.find((t) => {
    const r = t.terminalRef;
    if (t.type !== 'terminal' || !r || r.serverName !== serverName) return false;
    return r.kind === 'windowId' ? r.windowId === windowId : r.ref === windowRef;
  });
}
