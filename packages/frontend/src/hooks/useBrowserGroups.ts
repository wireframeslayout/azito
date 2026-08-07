import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNotificationChannel } from './useNotificationChannel';

export interface BrowserGroupInfo {
  groupId: string;
  pageCount: number;
  urls: (string | null)[];
}

export interface BrowserGroupsState {
  groups: Record<string, BrowserGroupInfo[]>;
  errors: Record<string, string>;
  refresh: () => void;
  /**
   * True once the current server set has completed its first fetch (success or failure).
   * Stays true across subsequent polls/refreshes so the UI doesn't flash back to a
   * "loading" state on every 30s poll — it only resets when the server set itself changes.
   */
  loaded: boolean;
}

interface BrowserStatusResponse {
  running: boolean;
  clientCount: number;
  pages: { id: string; group: string; clientCount: number; url: string | null }[];
}

function aggregateGroups(pages: BrowserStatusResponse['pages']): BrowserGroupInfo[] {
  const map = new Map<string, BrowserGroupInfo>();
  for (const page of pages) {
    const existing = map.get(page.group);
    if (existing) {
      existing.pageCount++;
      existing.urls.push(page.url);
    } else {
      map.set(page.group, { groupId: page.group, pageCount: 1, urls: [page.url] });
    }
  }
  return Array.from(map.values());
}

const POLL_INTERVAL = 30_000;

export function useBrowserGroups(serverNames: string[]): BrowserGroupsState {
  const [groups, setGroups] = useState<Record<string, BrowserGroupInfo[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);

  const serverNamesKey = serverNames.join(',');
  const [loaded, setLoaded] = useState(false);
  // Tracks which server set `loaded` currently describes, so a manual refresh() or the
  // 30s poll (same key, new revision) never resets `loaded` back to false — only a change
  // in the server set itself (e.g. switching projects) should re-show the loading state.
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const names = serverNamesKey ? serverNamesKey.split(',') : [];
    if (loadedKeyRef.current !== serverNamesKey) {
      setLoaded(false);
    }

    if (names.length === 0) {
      setGroups({});
      setErrors({});
      loadedKeyRef.current = serverNamesKey;
      setLoaded(true);
      return;
    }

    let cancelled = false;

    async function fetchAll() {
      const result: Record<string, BrowserGroupInfo[]> = {};
      const failed: Record<string, string> = {};
      await Promise.all(
        names.map(async (name) => {
          try {
            const status = await api<BrowserStatusResponse>(`/browser/status?server=${encodeURIComponent(name)}`);
            const grouped = aggregateGroups(status.pages);
            if (grouped.length > 0) {
              result[name] = grouped;
            }
          } catch (e) {
            console.debug(`[useBrowserGroups] failed to fetch status for ${name}:`, e);
            failed[name] = e instanceof Error ? e.message : String(e);
          }
        }),
      );
      if (!cancelled) {
        setGroups(result);
        setErrors(failed);
        loadedKeyRef.current = serverNamesKey;
        setLoaded(true);
      }
    }

    void fetchAll();

    const timer = setInterval(fetchAll, POLL_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [serverNamesKey, revision]);

  useNotificationChannel({
    onBrowserOpened: useCallback(() => {
      refresh();
    }, [refresh]),
    onConnected: useCallback(() => {
      refresh();
    }, [refresh]),
  });

  return { groups, errors, refresh, loaded };
}
