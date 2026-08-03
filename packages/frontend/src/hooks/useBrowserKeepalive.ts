import { useEffect } from 'react';
import { api } from '../api/client';

const KEEPALIVE_INTERVAL_MS = 60 * 1000;

/** One shared-browser instance to keep alive: a server + the group (pageId) on it. */
export interface BrowserGroupRef {
  serverName: string;
  pageId: string;
}

/**
 * Sends a periodic keepalive for every given browser group, so the hub/agent
 * BrowserSession sweeper (see BrowserSession.ts) knows the group is still present
 * somewhere in the UI and keeps its Chromium tabs alive past the idle TTL. Sends
 * nothing when `groups` is empty, and once immediately on mount so a fresh page
 * load doesn't wait a full interval before the first signal lands.
 *
 * Generalized (originally took `PersistedTab[]` directly) so both Workspace-level
 * browser tabs and TaskPanel's own task-scoped `v-browser:` tabs can share one
 * implementation — callers derive their own `BrowserGroupRef[]` and are responsible
 * for keeping its reference stable when the underlying tab set hasn't actually
 * changed (the effect re-sends on every `groups` identity change, same as this hook
 * always did against `tabs` before).
 */
export function useBrowserKeepalive(groups: BrowserGroupRef[]): void {
  useEffect(() => {
    const sendKeepalive = () => {
      const groupsByServer = new Map<string, Set<string>>();
      for (const { serverName, pageId } of groups) {
        if (!groupsByServer.has(serverName)) groupsByServer.set(serverName, new Set());
        groupsByServer.get(serverName)!.add(pageId);
      }
      if (groupsByServer.size === 0) return;

      for (const [serverName, groupIds] of groupsByServer) {
        api('/browser/keepalive', {
          method: 'POST',
          body: JSON.stringify({ server: serverName, groups: Array.from(groupIds) }),
        }).catch(() => {});
      }
    };

    sendKeepalive();
    const interval = setInterval(sendKeepalive, KEEPALIVE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [groups]);
}
