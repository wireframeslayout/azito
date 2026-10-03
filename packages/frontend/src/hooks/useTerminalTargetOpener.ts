import { useCallback, useEffect, useRef } from 'react';
import type { Session } from '../pages/workspace/types';
import type { TerminalRef } from '../lib/terminalRef';
import { connectResolvedTerminal, muxKindOfServer, resolveTerminalOpen, settlePendingOpens, type PendingTerminalOpen, type ServerMuxInfo, type TerminalOpenTarget } from '../lib/terminalTargetOpen';
import { useServerStatuses } from './useServerStatuses';

/**
 * For components outside the workspace page: wraps a ref-taking `connect` so a row / target is opened by windowId,
 * or by a target resolved against the server's mux kind (never a tmux ref on a misao server).
 */
export function useOpenTerminalTarget(connect: (ref: TerminalRef, projectId?: number) => void): (req: TerminalOpenTarget, projectId?: number) => void {
  const { servers } = useServerStatuses();
  return (req, projectId) => connectResolvedTerminal(req, { muxKind: muxKindOfServer(servers, req.serverName) }, connect, projectId);
}

/**
 * For the workspace page: opens a terminal from a target string, waiting for the server list / sessions when the
 * target cannot be resolved yet (a page load straight from a push URL) and reporting an error when it never can.
 */
export function useTerminalTargetOpener(opts: {
  servers: readonly ServerMuxInfo[];
  sessionData: Record<string, Session[]>;
  connect: (ref: TerminalRef, projectId?: number) => void;
}): (req: TerminalOpenTarget, projectId?: number) => void {
  const { servers, sessionData, connect } = opts;
  const pendingRef = useRef<PendingTerminalOpen[]>([]);
  const latest = useRef({ servers, sessionData, connect });
  latest.current = { servers, sessionData, connect };

  const open = useCallback((req: TerminalOpenTarget, projectId?: number) => {
    const { servers: s, sessionData: d, connect: c } = latest.current;
    const r = resolveTerminalOpen(req, { muxKind: muxKindOfServer(s, req.serverName), sessions: d[req.serverName] });
    if (r.status === 'ready') c(r.ref, projectId);
    else if (r.status === 'wait') pendingRef.current.push({ req, projectId, at: Date.now() });
    else console.error(`[terminal] cannot open ${req.serverName}/${req.target}: window not found`);
  }, []);

  useEffect(() => {
    if (pendingRef.current.length === 0) return;
    const settled = settlePendingOpens(pendingRef.current, servers, sessionData, Date.now());
    pendingRef.current = settled.waiting;
    for (const { entry, ref } of settled.open) connect(ref, entry.projectId);
    for (const entry of settled.failed) console.error(`[terminal] cannot open ${entry.req.serverName}/${entry.req.target}: window not found`);
  }, [servers, sessionData, connect]);

  return open;
}
