import { terminalTabId, terminalRefDisplayLabel, retargetedTerminalRef, type TerminalRef } from './terminalRef';
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

/**
 * Re-points every tab in `oldTabIds` at `windowId` (pane resolved against the post-respawn
 * `sessions`). A tab whose id does not change is only reconnected. `moves` lists the id renames
 * so the split layout can follow them.
 */
export function applyRetargetTabs<T extends TerminalTabLike>(
  state: TabsState<T>,
  oldTabIds: string[],
  serverName: string,
  windowId: number,
  sessions: Session[] | undefined,
): TabsState<T> & { moves: { oldId: string; newId: string }[] } {
  let current = state;
  const moves: { oldId: string; newId: string }[] = [];
  for (const oldId of oldTabIds) {
    const newRef = retargetedTerminalRef(oldId, serverName, windowId, sessions);
    const newId = terminalTabId(newRef);
    if (newId === oldId) {
      current = { ...current, tabs: current.tabs.map((t) => (t.id === oldId ? { ...t, reconnectKey: (t.reconnectKey ?? 0) + 1 } : t)) };
    } else {
      current = applyRetargetTab(current, oldId, newRef);
      moves.push({ oldId, newId });
    }
  }
  return { ...current, moves };
}

/** Every open terminal tab showing window `windowId` (any pane, windowId or ref form). */
export function findWindowTerminalTabs<T extends TerminalTabLike>(tabs: T[], serverName: string, windowId: number, sessions: Session[] | undefined): T[] {
  const windowRef = sessions?.flatMap((s) => s.windows).find((w) => w.windowId === windowId)?.ref;
  return tabs.filter((t) => {
    const r = t.terminalRef;
    if (t.type !== 'terminal' || !r || r.serverName !== serverName) return false;
    return r.kind === 'windowId' ? r.windowId === windowId : r.ref === windowRef;
  });
}
