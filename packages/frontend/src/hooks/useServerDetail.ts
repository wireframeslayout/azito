import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Server, Session, ServerStatus } from './useServerManagement';
import { useServerStatuses } from './useServerStatuses';
import type { InstallStatusResponse } from '../components/servers/serverSections';

// Issue #29 review, Important finding 2: isolation_report (cleanup/doctor
// outcome JSON) is a detail-only field the servers-list API deliberately
// excludes — see GET /api/servers/:name on the server side. `kind`
// distinguishes the synchronous remote-token-purge outcome PUT
// isolationIntent:true records (`'cleanup'`) from the future isolation
// doctor's own writes (`'verification'`, not implemented yet).
export interface IsolationReport {
  kind: 'cleanup' | 'verification';
  cleanup?: 'done' | 'failed' | 'skipped';
  reason?: string;
  error?: string;
  at?: string;
}

interface UseServerDetailResult {
  server: Server | null;
  servers: Server[];
  status: ServerStatus | null;
  installStatus: InstallStatusResponse | null;
  sessions: Session[];
  isolationReport: IsolationReport | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useServerDetail(serverName: string | null): UseServerDetailResult {
  // サーバー一覧・接続状態は ServerStatusProvider から供給（グローバルにポーリング済み）。
  // ここでは install-status とセッション一覧のみ、この画面固有に取得する。
  const { servers, statuses, refresh: refreshStatuses } = useServerStatuses();
  const [installStatus, setInstallStatus] = useState<InstallStatusResponse | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isolationReport, setIsolationReport] = useState<IsolationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!serverName) return;
    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(serverName);
      const [srvList, installRes, sessionsRes, detailRes] = await Promise.all([
        refreshStatuses(),
        api<InstallStatusResponse>(`/servers/${encoded}/install-status`),
        api<Session[]>(`/servers/${encoded}/sessions`).catch(() => [] as Session[]),
        // Issue #29 review, Important finding 2: isolationReport only
        // exists on the per-server detail route (never the list) — fetched
        // alongside the other detail-only extras. Best-effort: a fetch
        // failure here must not block the rest of the detail page (e.g. a
        // 404 mid-navigation while the server list is still catching up).
        api<{ isolationReport: string | null }>(`/servers/${encoded}`).catch(() => null),
      ]);
      if (!srvList.some((s) => s.name === serverName)) throw new Error(`Server "${serverName}" not found`);
      setInstallStatus(installRes);
      setSessions(Array.isArray(sessionsRes) ? sessionsRes : []);
      let parsedReport: IsolationReport | null = null;
      if (detailRes?.isolationReport) {
        try {
          parsedReport = JSON.parse(detailRes.isolationReport) as IsolationReport;
        } catch { /* malformed report JSON — treat as absent rather than crash the detail page */ }
      }
      setIsolationReport(parsedReport);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverName, refreshStatuses]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const server = servers.find((s) => s.name === serverName) ?? null;
  const status = serverName ? statuses[serverName] ?? null : null;

  return { server, servers, status, installStatus, sessions, isolationReport, loading, error, refresh: fetchAll };
}
