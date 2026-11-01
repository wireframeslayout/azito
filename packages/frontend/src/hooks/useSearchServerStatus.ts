import { useEffect, useState } from 'react';
import { fetchSessionListing, keepUnavailableKinds } from '../lib/fetchServerSessions';
import type { Session, Window } from '../pages/workspace/types';
import { useNotificationChannel } from './useNotificationChannel';

export function useSearchServerStatus(windows: Window[]) {
  const [sessions, setSessions] = useState<Record<string, Session[]>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const [unreachable, setUnreachable] = useState<string[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  useNotificationChannel({ onSessionsUpdated: () => setRefreshKey(value => value + 1) });
  const serverKey = JSON.stringify([...new Set(windows.map(w => w.serverName))].sort());
  const kindsKey = JSON.stringify(windows.map(w => [w.serverName, w.muxRef?.kind ?? 'tmux']).sort());
  useEffect(() => {
    let cancelled = false;
    const names: string[] = JSON.parse(serverKey);
    const kinds: [string, string][] = JSON.parse(kindsKey);
    setFailed(previous => previous.filter(name => names.includes(name)));
    setUnreachable(previous => previous.filter(name => names.includes(name)));
    for (const name of names) {
      void fetchSessionListing(name).then(listing => {
        if (cancelled) return;
        setSessions(previous => ({ ...previous, [name]: keepUnavailableKinds(previous[name], listing) }));
        const relevant = listing.unavailable.some(unavailable => kinds.some(([server, kind]) => server === name && kind === unavailable.kind));
        setFailed(previous => relevant ? [...new Set([...previous, name])] : previous.filter(value => value !== name));
        setUnreachable(previous => previous.filter(value => value !== name));
      }, () => {
        if (cancelled) return;
        setFailed(previous => [...new Set([...previous, name])]);
        setUnreachable(previous => [...new Set([...previous, name])]);
      });
    }
    return () => { cancelled = true; };
  }, [serverKey, kindsKey, refreshKey]);
  return { sessions, failed, unreachable, retry: () => setRefreshKey(value => value + 1) };
}
