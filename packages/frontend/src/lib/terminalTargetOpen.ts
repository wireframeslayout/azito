import type { MuxDriverKind } from '@azito/shared';
import type { Session } from '../pages/workspace/types';
import { resolveTerminalRefFromTarget, type ConnectPaneFn, type TargetResolution, type TerminalRef } from './terminalRef';

/** A request to open a terminal from what a notification / activity row / URL carries: a windowId when known. */
export interface TerminalOpenTarget {
  serverName: string;
  target: string;
  windowId?: number;
}

export interface ServerMuxInfo {
  name: string;
  defaultMux: MuxDriverKind;
}

interface TerminalOpenContext {
  muxKind?: MuxDriverKind;
  sessions?: Session[];
}

/** The mux kind of a server, undefined while the server list has not reported it. */
export function muxKindOfServer(servers: readonly ServerMuxInfo[], serverName: string): MuxDriverKind | undefined {
  const server = servers.find((s) => s.name === serverName);
  return server?.defaultMux;
}

/** windowId wins; otherwise the target string is resolved (never into a tmux ref on a non-tmux server). */
export function resolveTerminalOpen(req: TerminalOpenTarget, ctx: TerminalOpenContext): TargetResolution {
  if (req.windowId != null) {
    return { status: 'ready', ref: { kind: 'windowId', serverName: req.serverName, windowId: req.windowId, pane: 1 } };
  }
  return resolveTerminalRefFromTarget(req.serverName, req.target, ctx);
}

/**
 * Open by ref when the target resolves here; otherwise hand the target string to `connect`, whose string form
 * waits for the sessions and, failing that, lets the server resolve the target.
 */
export function connectResolvedTerminal(
  req: TerminalOpenTarget,
  ctx: TerminalOpenContext,
  connect: ConnectPaneFn,
  projectId?: number,
): void {
  const resolution = resolveTerminalOpen(req, ctx);
  if (resolution.status === 'ready') connect(resolution.ref, projectId);
  else connect(req.serverName, req.target, projectId);
}

export const PENDING_TERMINAL_OPEN_TTL_MS = 10_000;

export interface PendingOpenDeps {
  getServers: () => readonly ServerMuxInfo[];
  getSessions: (serverName: string) => Session[] | undefined;
  fetchSessions: (serverName: string) => Promise<Session[]>;
  connect: (ref: TerminalRef, projectId?: number) => void;
  /** Opens a tab that the server resolves from the target string (the WS `target=` path). */
  connectByTarget: (req: TerminalOpenTarget, projectId?: number) => void;
  ttlMs?: number;
}

interface PendingEntry {
  req: TerminalOpenTarget;
  projectId?: number;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Opens terminals from a target string that cannot be resolved yet (the server list or the server's sessions have not
 * arrived). A waiting open fetches the server's sessions itself; when they cannot be fetched, they do not list the
 * window, or the deadline passes (checked before anything else), the open falls back to server-side resolution.
 */
export class PendingOpenQueue {
  private entries: PendingEntry[] = [];
  private fetched = new Map<string, Session[]>();
  private fetching = new Set<string>();
  private failed = new Set<string>();

  constructor(private readonly deps: PendingOpenDeps) {}

  private get ttlMs(): number {
    return this.deps.ttlMs ?? PENDING_TERMINAL_OPEN_TTL_MS;
  }

  private resolve(req: TerminalOpenTarget): TargetResolution {
    return resolveTerminalOpen(req, {
      muxKind: muxKindOfServer(this.deps.getServers(), req.serverName),
      sessions: this.deps.getSessions(req.serverName) ?? this.fetched.get(req.serverName),
    });
  }

  open(req: TerminalOpenTarget, projectId?: number): void {
    const r = this.resolve(req);
    if (r.status === 'ready') this.deps.connect(r.ref, projectId);
    else if (r.status === 'unresolved') this.deps.connectByTarget(req, projectId);
    else {
      const timer = setTimeout(() => this.settle(), this.ttlMs);
      this.entries.push({ req, projectId, at: Date.now(), timer });
      this.settle();
    }
  }

  /** Re-evaluate the waiting opens; call when the server list or sessions change. */
  notify(): void {
    if (this.entries.length > 0) this.settle();
  }

  dispose(): void {
    for (const e of this.entries) clearTimeout(e.timer);
    this.entries = [];
  }

  private settle(): void {
    const now = Date.now();
    const waiting: PendingEntry[] = [];
    for (const e of this.entries) {
      if (now - e.at >= this.ttlMs || this.failed.has(e.req.serverName)) {
        clearTimeout(e.timer);
        this.deps.connectByTarget(e.req, e.projectId);
        continue;
      }
      const r = this.resolve(e.req);
      if (r.status === 'ready') {
        clearTimeout(e.timer);
        this.deps.connect(r.ref, e.projectId);
      } else if (r.status === 'unresolved') {
        clearTimeout(e.timer);
        this.deps.connectByTarget(e.req, e.projectId);
      } else {
        waiting.push(e);
        this.ensureFetched(e.req.serverName);
      }
    }
    this.entries = waiting;
    if (waiting.length === 0) {
      this.fetched.clear();
      this.failed.clear();
    }
  }

  private ensureFetched(serverName: string): void {
    const kind = muxKindOfServer(this.deps.getServers(), serverName);
    if (kind === undefined || this.deps.getSessions(serverName) || this.fetched.has(serverName) || this.fetching.has(serverName)) return;
    this.fetching.add(serverName);
    this.deps.fetchSessions(serverName).then(
      (sessions) => { this.fetching.delete(serverName); this.fetched.set(serverName, sessions); this.settle(); },
      () => { this.fetching.delete(serverName); this.failed.add(serverName); this.settle(); },
    );
  }
}
