import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useNotificationChannel } from './useNotificationChannel';

interface AgentWatchEntry {
  serverName: string;
  target: string;
  label: string | null;
}

function watchKey(serverName: string, target: string): string {
  return `${serverName}::${target}`;
}

// Idle-watch push notifications: "notify me when this pane goes idle" is a
// one-shot registration keyed by the browser's current push subscription
// endpoint (same endpoint the GlobalSettingsPage notifications flow
// registers via subscribeToPush — see utils/pushNotifications.ts). Without an
// active push subscription there is nowhere to deliver the notification, so
// `endpoint` stays null and callers should treat the feature as unavailable.
export function useAgentWatch() {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [watchedKeys, setWatchedKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const reconvergeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending reconverge timer on unmount so it cannot fire (and
  // call setState) after the component is gone.
  useEffect(() => () => {
    if (reconvergeTimerRef.current !== null) clearTimeout(reconvergeTimerRef.current);
  }, []);

  const refresh = useCallback(async (ep: string) => {
    try {
      const watches = await api<AgentWatchEntry[]>(`/agent-watches?endpoint=${encodeURIComponent(ep)}`);
      setWatchedKeys(new Set(watches.map((w) => watchKey(w.serverName, w.target))));
    } catch {
      // Leave the previous snapshot in place; a transient fetch failure
      // should not make already-registered watches appear to disappear.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        setLoading(false);
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (sub) {
          setEndpoint(sub.endpoint);
          await refresh(sub.endpoint);
        }
      } catch {
        // Not subscribed / unsupported — endpoint stays null.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    init();
    return () => { cancelled = true; };
  }, [refresh]);

  // Watches are one-shot on the server: the row is deleted as soon as the
  // idle push fires. Mirror that here — when an agent:activity event reports
  // running:false for a watched key, drop it from local state immediately and
  // re-fetch from the server to reconverge (otherwise the 🔔/🔕 menu toggle
  // would keep showing "watching" for an already-consumed watch).
  useNotificationChannel({
    onAgentActivity: (payload) => {
      if (payload.running) return;
      const key = watchKey(payload.serverName, payload.target);
      if (!watchedKeys.has(key)) return;
      setWatchedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      // Reconverge with the server after a short delay: the server-side
      // bridge deletes the watch row on the same bus event that produced
      // this WS message, so an immediate refetch could race it and
      // resurrect the key. Only the latest timer is kept; it is cleared
      // on unmount (see the cleanup effect above).
      if (endpoint) {
        if (reconvergeTimerRef.current !== null) clearTimeout(reconvergeTimerRef.current);
        reconvergeTimerRef.current = setTimeout(() => {
          reconvergeTimerRef.current = null;
          void refresh(endpoint);
        }, 1500);
      }
    },
  });

  const isWatched = useCallback(
    (serverName: string, target: string) => watchedKeys.has(watchKey(serverName, target)),
    [watchedKeys],
  );

  const toggleWatch = useCallback(async (serverName: string, target: string, label?: string) => {
    if (!endpoint) return;
    const key = watchKey(serverName, target);
    const currentlyWatched = watchedKeys.has(key);

    if (currentlyWatched) {
      await api('/agent-watches', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint, serverName, target }),
      });
    } else {
      await api('/agent-watches', {
        method: 'POST',
        body: JSON.stringify({ endpoint, serverName, target, label }),
      });
    }
    await refresh(endpoint);
  }, [endpoint, watchedKeys, refresh]);

  return {
    supported: endpoint !== null,
    loading,
    watchedKeys,
    isWatched,
    toggleWatch,
  };
}
