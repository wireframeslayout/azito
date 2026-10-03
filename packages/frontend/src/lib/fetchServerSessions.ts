import { api } from '../api/client';
import type { Session } from '../pages/workspace/types';

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
