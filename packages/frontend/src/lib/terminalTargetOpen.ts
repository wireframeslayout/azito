import { muxKindForRuntime, type MuxDriverKind, type MuxRuntime } from '@azito/shared';
import type { Session } from '../pages/workspace/types';
import { resolveTerminalRefFromTarget, type TargetResolution, type TerminalRef } from './terminalRef';

/** A request to open a terminal from what a notification / activity row / URL carries: a windowId when known. */
export interface TerminalOpenTarget {
  serverName: string;
  target: string;
  windowId?: number;
}

export interface ServerMuxInfo {
  name: string;
  muxRuntime?: MuxRuntime;
}

interface TerminalOpenContext {
  muxKind?: MuxDriverKind;
  sessions?: Session[];
}

/** The mux kind of a server, undefined while the server list has not reported it. */
export function muxKindOfServer(servers: readonly ServerMuxInfo[], serverName: string): MuxDriverKind | undefined {
  const server = servers.find((s) => s.name === serverName);
  return server ? muxKindForRuntime(server.muxRuntime ?? 'system') : undefined;
}

/** windowId wins; otherwise the target string is resolved (never into a tmux ref on a non-tmux server). */
export function resolveTerminalOpen(req: TerminalOpenTarget, ctx: TerminalOpenContext): TargetResolution {
  if (req.windowId != null) {
    return { status: 'ready', ref: { kind: 'windowId', serverName: req.serverName, windowId: req.windowId, pane: 1 } };
  }
  return resolveTerminalRefFromTarget(req.serverName, req.target, ctx);
}

/** Open now, or log why it cannot be opened; a terminal tab is never created from an unresolved target. */
export function connectResolvedTerminal(
  req: TerminalOpenTarget,
  ctx: TerminalOpenContext,
  connect: (ref: TerminalRef, projectId?: number) => void,
  projectId?: number,
): void {
  const resolution = resolveTerminalOpen(req, ctx);
  if (resolution.status === 'ready') {
    connect(resolution.ref, projectId);
    return;
  }
  console.error(`[terminal] cannot open ${req.serverName}/${req.target}: window not resolved (${resolution.status})`);
}

export interface PendingTerminalOpen {
  req: TerminalOpenTarget;
  projectId?: number;
  at: number;
}

export const PENDING_TERMINAL_OPEN_TTL_MS = 30_000;

/**
 * Settle opens that were waiting for the server list / sessions. `open` are ready to connect, `failed` are
 * unresolvable (or expired), `waiting` stay queued.
 */
export function settlePendingOpens(
  pending: readonly PendingTerminalOpen[],
  servers: readonly ServerMuxInfo[],
  sessionData: Record<string, Session[]>,
  now: number,
): { open: Array<{ entry: PendingTerminalOpen; ref: TerminalRef }>; failed: PendingTerminalOpen[]; waiting: PendingTerminalOpen[] } {
  const out = { open: [] as Array<{ entry: PendingTerminalOpen; ref: TerminalRef }>, failed: [] as PendingTerminalOpen[], waiting: [] as PendingTerminalOpen[] };
  for (const entry of pending) {
    const r = resolveTerminalOpen(entry.req, { muxKind: muxKindOfServer(servers, entry.req.serverName), sessions: sessionData[entry.req.serverName] });
    if (r.status === 'ready') out.open.push({ entry, ref: r.ref });
    else if (r.status === 'unresolved' || now - entry.at > PENDING_TERMINAL_OPEN_TTL_MS) out.failed.push(entry);
    else out.waiting.push(entry);
  }
  return out;
}
