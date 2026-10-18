import { useCallback, useEffect, useRef } from 'react';
import { api } from '../api/client';
import type { Session } from '../pages/workspace/types';
import type { ConnectPaneFn, TerminalRef } from '../lib/terminalRef';
import { connectResolvedTerminal, muxKindOfServer, PendingOpenQueue, type ServerMuxInfo, type TerminalOpenTarget } from '../lib/terminalTargetOpen';
import { useServerStatuses } from './useServerStatuses';

/**
 * For components outside the workspace page: wraps `connectPane` so a row / target is opened by windowId, or by a
 * target resolved against the server's mux kind. What cannot be resolved here goes to connectPane's string form, which
 * waits for the sessions and finally lets the server resolve it (never a tmux ref on a misao server).
 */
export function useOpenTerminalTarget(connect: ConnectPaneFn): (req: TerminalOpenTarget, projectId?: number) => void {
  const { servers } = useServerStatuses();
  return (req, projectId) => connectResolvedTerminal(req, { muxKind: muxKindOfServer(servers, req.serverName) }, connect, projectId);
}

async function fetchServerSessions(serverName: string): Promise<Session[]> {
  const sessions = await api<Session[]>(`/servers/${encodeURIComponent(serverName)}/sessions`);
  if (!Array.isArray(sessions)) throw new Error(`sessions of ${serverName} unavailable`);
  return sessions;
}

/**
 * For the workspace page: opens a terminal from a target string. A target that cannot be resolved yet fetches the
 * server's sessions itself; when that fails or the deadline passes, the tab is opened with the target and the server
 * resolves it.
 */
export function useTerminalTargetOpener(opts: {
  servers: readonly ServerMuxInfo[];
  sessionData: Record<string, Session[]>;
  connect: (ref: TerminalRef, projectId?: number) => void;
  connectByTarget: (req: TerminalOpenTarget, projectId?: number) => void;
}): (req: TerminalOpenTarget, projectId?: number) => void {
  const { servers, sessionData } = opts;
  const latest = useRef(opts);
  latest.current = opts;
  const queueRef = useRef<PendingOpenQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new PendingOpenQueue({
      getServers: () => latest.current.servers,
      getSessions: (name) => latest.current.sessionData[name],
      fetchSessions: fetchServerSessions,
      connect: (ref, projectId) => latest.current.connect(ref, projectId),
      connectByTarget: (req, projectId) => latest.current.connectByTarget(req, projectId),
    });
  }
  const queue = queueRef.current;

  useEffect(() => {
    queue.notify();
  }, [queue, servers, sessionData]);
  useEffect(() => () => queue.dispose(), [queue]);

  return useCallback((req: TerminalOpenTarget, projectId?: number) => queue.open(req, projectId), [queue]);
}
