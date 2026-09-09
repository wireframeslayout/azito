import { useEffect, useMemo, useRef } from 'react';
import type { PersistedTab } from './useTabPersistence';
import type { Server } from '../pages/workspace/types';
import type { PaneLayoutState } from './usePaneLayout';
import { listPanes } from './paneLayoutTree';
import { api } from '../api/client';

const DEBOUNCE_MS = 150;

function isHerdrTab(tab: PersistedTab, servers: Server[]): boolean {
  if (tab.type !== 'terminal' || !tab.serverName) return false;
  const srv = servers.find((s: Server) => s.name === tab.serverName);
  return srv?.muxRuntime === 'herdr';
}

function focusHerdrTab(tab: PersistedTab): void {
  const ref = tab.terminalRef;
  if (!ref) return;
  if (ref.kind === 'windowId') {
    api(`/windows/${ref.windowId}/focus`, { method: 'POST' }).catch(() => {});
  } else {
    api(`/servers/${ref.serverName}/mux/focus`, {
      method: 'POST',
      body: JSON.stringify({ ref: ref.ref }),
    }).catch(() => {});
  }
}

export interface UseHerdrTabFocusResult {
  herdrConflictPaneIds: Set<string>;
}

export function useHerdrTabFocus(
  focusedActiveTabId: string | null,
  tabs: PersistedTab[],
  servers: Server[],
  layoutState: PaneLayoutState,
): UseHerdrTabFocusResult {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const serversRef = useRef(servers);
  serversRef.current = servers;
  const focusedActiveTabIdRef = useRef(focusedActiveTabId);
  focusedActiveTabIdRef.current = focusedActiveTabId;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendFocus = useMemo(() => {
    return (tabId: string | null) => {
      if (!tabId) return;
      const tab = tabsRef.current.find((t: PersistedTab) => t.id === tabId);
      if (!tab || !isHerdrTab(tab, serversRef.current)) return;
      focusHerdrTab(tab);
    };
  }, []);

  useEffect(() => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      sendFocus(focusedActiveTabId);
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, [focusedActiveTabId, sendFocus]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        sendFocus(focusedActiveTabIdRef.current);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [sendFocus]);

  const herdrConflictPaneIds = useMemo(() => {
    const conflict = new Set<string>();
    const panes = listPanes(layoutState.root);
    const serverToPanes = new Map<string, string[]>();

    for (const pane of panes) {
      if (!pane.activeTabId) continue;
      const tab = tabs.find((t: PersistedTab) => t.id === pane.activeTabId);
      if (!tab || !isHerdrTab(tab, servers)) continue;
      const serverName = tab.serverName!;
      const existing = serverToPanes.get(serverName);
      if (existing) existing.push(pane.id);
      else serverToPanes.set(serverName, [pane.id]);
    }

    for (const [, paneIds] of serverToPanes) {
      if (paneIds.length < 2) continue;
      for (const pid of paneIds) {
        if (pid !== layoutState.focusedPaneId) conflict.add(pid);
      }
    }

    return conflict;
  }, [layoutState.root, layoutState.focusedPaneId, tabs, servers]);

  return { herdrConflictPaneIds };
}
