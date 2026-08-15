import { useCallback, useEffect, useState } from 'react';
import { api, apiWithStatus } from '../api/client';
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

// Issue #29 review, Important finding 3: `kind` is the one field every
// current and future isolationReport variant is required to carry (see the
// interface's own doc comment distinguishing 'cleanup' from the future
// 'verification' doctor writes) — a body missing it is not a report this
// hook understands, so it's treated the same as a fetch failure rather than
// silently coerced into `null` (which the UI cannot tell apart from "no
// report exists").
//
// Issue #29 review (5th pass), Important finding 3: `kind==='cleanup'`
// additionally requires `cleanup` to actually be one of the three values the
// interface declares — the previous version accepted `{ kind: 'cleanup' }`
// with no `cleanup` field (or any junk value in it) as "valid", which the UI
// (OverviewSection's cleanup-outcome switch) then had no defined behavior
// for. `kind==='verification'` still only checks the discriminant itself —
// that variant is not implemented server-side yet (see the interface's doc
// comment), so there is no further shape to require of it today; the
// discriminant check alone is deliberately the "minimal" bar the task
// description asks for, left for a future round once the doctor writes its
// first real 'verification' report.
export function isValidIsolationReport(value: unknown): value is IsolationReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'cleanup') {
    const cleanup = (value as { cleanup?: unknown }).cleanup;
    return cleanup === 'done' || cleanup === 'failed' || cleanup === 'skipped';
  }
  return kind === 'verification';
}

// Issue #29 review (5th pass), Important finding 3: the detail fetch's body
// is untyped JSON from the network — asserting it as `{ isolationReport:
// string | null }` (the old signature) let a null/array/scalar body reach
// `detailResult.body.isolationReport` below, which throws for `null` (the
// whole fetchAll() try/catch would then report a spurious page-level
// `error` instead of the intended "unavailable" Notice) and silently reads
// `undefined` for an array or scalar body (indistinguishable from "no
// report exists"). This guards for "a non-array object that owns an
// `isolationReport` property" — anything else is treated the same as an
// unreadable report, per this hook's existing "unavailable on any
// unrecognized shape" contract.
export function hasIsolationReportField(body: unknown): body is { isolationReport: unknown } {
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'isolationReport');
}

interface UseServerDetailResult {
  server: Server | null;
  servers: Server[];
  status: ServerStatus | null;
  installStatus: InstallStatusResponse | null;
  sessions: Session[];
  isolationReport: IsolationReport | null;
  // Issue #29 review, Important finding 3: true when this server declares
  // isolationIntent but the detail fetch that would carry isolationReport
  // failed outright or came back in a shape this hook doesn't recognize —
  // distinguishes "we don't know whether cleanup succeeded" from "cleanup
  // succeeded" (isolationReport === null), which a bare `.catch(() => null)`
  // could not: both looked identical to the UI before this field existed.
  isolationReportUnavailable: boolean;
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
  const [isolationReportUnavailable, setIsolationReportUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    if (!serverName) return;
    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(serverName);
      // Issue #29 review, Important finding 3: the isolationReport fetch
      // used to swallow every failure (network error, 4xx/5xx, malformed
      // body) into a bare `null` via `.catch(() => null)` — indistinguishable
      // from "cleanup completed cleanly, no report to show". A server
      // declaring isolationIntent needs that distinction surfaced (see
      // isolationReportUnavailable below), so this uses apiWithStatus and
      // treats non-2xx / a thrown error / an unrecognized body shape as
      // "unavailable", not as "no warning".
      const [srvList, installRes, sessionsRes, detailResult] = await Promise.all([
        refreshStatuses(),
        api<InstallStatusResponse>(`/servers/${encoded}/install-status`),
        api<Session[]>(`/servers/${encoded}/sessions`).catch(() => [] as Session[]),
        apiWithStatus<unknown>(`/servers/${encoded}`).catch(() => null),
      ]);
      if (!srvList.some((s) => s.name === serverName)) throw new Error(`Server "${serverName}" not found`);
      setInstallStatus(installRes);
      setSessions(Array.isArray(sessionsRes) ? sessionsRes : []);

      let parsedReport: IsolationReport | null = null;
      let reportUnavailable = false;
      if (detailResult === null || detailResult.status < 200 || detailResult.status >= 300) {
        reportUnavailable = true;
      } else if (!hasIsolationReportField(detailResult.body)) {
        // Issue #29 review (5th pass), Important finding 3: a 2xx body that
        // isn't a non-array object owning `isolationReport` at all (null,
        // an array, a scalar, or an object missing the field) is not a
        // shape this hook understands — treated as unavailable rather than
        // risking a `.isolationReport` access on a non-object body.
        reportUnavailable = true;
      } else if (typeof detailResult.body.isolationReport === 'string' && detailResult.body.isolationReport) {
        try {
          const parsed = JSON.parse(detailResult.body.isolationReport) as unknown;
          if (isValidIsolationReport(parsed)) {
            parsedReport = parsed;
          } else {
            reportUnavailable = true;
          }
        } catch {
          reportUnavailable = true;
        }
      } else if (detailResult.body.isolationReport != null) {
        // Present but neither a string nor null/undefined (e.g. a stray
        // number/object from a malformed response) — not a shape this hook
        // can parse as a report.
        reportUnavailable = true;
      }
      // reportUnavailable only matters (as UI-visible uncertainty) for a
      // server that actually declared isolation — a server that never
      // opted in has no promise to fail to verify.
      const declaredIsolated = srvList.find((s) => s.name === serverName)?.isolationIntent ?? false;
      setIsolationReport(parsedReport);
      setIsolationReportUnavailable(declaredIsolated && reportUnavailable);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [serverName, refreshStatuses]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const server = servers.find((s) => s.name === serverName) ?? null;
  const status = serverName ? statuses[serverName] ?? null : null;

  return {
    server, servers, status, installStatus, sessions,
    isolationReport, isolationReportUnavailable,
    loading, error, refresh: fetchAll,
  };
}
