import type { MuxDriverKind } from '@azito/shared';
import { api } from '../api/client';
import type { Session } from '../pages/workspace/types';
import { sessionKindOf } from './sessionKind';

/** What `keepUnavailableKinds` reads of a listed session (both session shapes the frontend keeps satisfy it). */
interface ListedSession { name: string; kind?: MuxDriverKind; windows: ReadonlyArray<{ ref: string }> }

export interface ServerSessionsResult {
  /** 取得できたサーバーのセッション。失敗・オフラインのサーバーは含まない。 */
  data: Record<string, Session[]>;
  /** オフラインと判定したサーバー名（ステータスが offline、またはハブが 503 agent_unreachable を返した）。 */
  offline: string[];
}

function isAgentUnreachable(body: unknown): boolean {
  return typeof body === 'object' && body !== null
    && (body as Record<string, unknown>)['error'] === 'agent_unreachable';
}

/**
 * 複数サーバーのセッションを並列取得する。ステータスが offline のサーバーは取得せずスキップし、
 * 1 台の遅延・失敗が他のサーバーの取得を待たせないよう Promise.allSettled で束ねる。
 */
export async function fetchSessionsForServers(
  servers: readonly { name: string }[],
  isOffline: (serverName: string) => boolean,
): Promise<ServerSessionsResult> {
  const data: Record<string, Session[]> = {};
  const offline: string[] = [];
  const targets = servers.filter((s) => {
    if (!isOffline(s.name)) return true;
    offline.push(s.name);
    return false;
  });
  const results = await Promise.allSettled(
    targets.map((s) => api<Session[] | { error: string }>(`/servers/${s.name}/sessions`)),
  );
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    if (Array.isArray(r.value)) data[targets[i].name] = r.value;
    else if (isAgentUnreachable(r.value)) offline.push(targets[i].name);
  });
  return { data, offline };
}

/** The server's current session list, or undefined when it cannot be read (callers fall back conservatively). */
export async function fetchSessionsOrUndefined(serverName: string): Promise<Session[] | undefined> {
  try {
    const r = await api<Session[] | { error: string }>(`/servers/${encodeURIComponent(serverName)}/sessions`);
    return Array.isArray(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** A mux the server hosts but could not list (its daemon stopped, reconnecting, or incompatible). */
export interface UnavailableMuxKind {
  kind: MuxDriverKind;
  reason: string;
}

/** One server listing: the sessions that could be listed, and the muxes that could not. */
export interface SessionListing<S> {
  sessions: S[];
  unavailable: UnavailableMuxKind[];
}

function isSessionListing<S>(body: unknown): body is SessionListing<S> {
  return typeof body === 'object' && body !== null
    && Array.isArray((body as Record<string, unknown>)['sessions'])
    && Array.isArray((body as Record<string, unknown>)['unavailable']);
}

/** `GET /sessions?detail=1`. Throws when the reply is not a listing (an error body), so callers never read "no windows". */
export async function fetchSessionListing<S extends Session | ListedSession = Session>(serverName: string): Promise<SessionListing<S>> {
  const body = await api<unknown>(`/servers/${encodeURIComponent(serverName)}/sessions?detail=1`);
  if (!isSessionListing<S>(body)) throw new Error(`sessions of ${serverName} unavailable`);
  return body;
}

/**
 * The sessions to show after a listing: the listed ones, plus the previous sessions of every mux that could not be
 * listed. A mux that is down says nothing about its windows, so they keep their last known state instead of reading as
 * deleted (which would close their tabs and mark them missing).
 */
export function keepUnavailableKinds<S extends ListedSession>(previous: readonly S[] | undefined, listing: SessionListing<S>): S[] {
  if (listing.unavailable.length === 0 || !previous) return listing.sessions;
  const down = new Set(listing.unavailable.map((u) => u.kind));
  return [...listing.sessions, ...previous.filter((s) => down.has(sessionKindOf(s)))];
}
