import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiWithStatus } from '../api/client';
import type { Server, Session, ServerStatus } from './useServerManagement';
import { useServerStatuses } from './useServerStatuses';
import { fetchSessionListing, sessionListingState, keepUnavailableKinds, SessionListingError } from '../lib/fetchServerSessions';
import type { InstallStatusResponse } from '../components/servers/serverSections';
import type { Window } from '../pages/workspace/types';
import { buildWindowIndex, type WindowIndexEntry } from '../lib/windowDisplay';
import { parseMuxDriverStatus, type MuxDriverStatus } from '../lib/muxDriverStatus';

// Issue #29 review, Important finding 2: isolation_report (cleanup/doctor
// outcome JSON) is a detail-only field the servers-list API deliberately
// excludes — see GET /api/servers/:name on the server side. `kind`
// distinguishes the synchronous remote-token-purge outcome PUT
// isolationIntent:true records (`'cleanup'`) from the isolation doctor's own
// writes (`'verification'`).
//
// Review round (Important finding 4): the server now persists these two
// kinds in SEPARATE columns/fields — `isolationReport` (verification-only)
// and `isolationCleanupReport` (cleanup-only) — so a doctor run can never
// clobber a settled cleanup outcome or vice versa. This union type is kept
// as the shape for EITHER field's parsed value (a given field only ever
// actually carries one `kind` in practice now), so `isValidIsolationReport`
// below stays a single shared validator for both.
export interface IsolationReport {
  kind: 'cleanup' | 'verification';
  // Issue #29 review (final pass), Important finding 2: 'pending' is the
  // marker `updateIsolationIntent` writes ATOMICALLY with a false->true
  // isolation_intent flip, before the cleanup attempt itself has run (see
  // Server.ts's ISOLATION_CLEANUP_PENDING_REPORT / IServerRepository doc
  // comment) — a legitimate, reachable value this hook must be able to
  // parse, not just the three settled outcomes.
  cleanup?: 'pending' | 'done' | 'failed' | 'skipped';
  reason?: string;
  error?: string;
  at?: string;
  // Issue #29 Step 2 C: the isolation doctor's own `kind: 'verification'`
  // fields (servers/isolationDoctor.ts's runIsolationDoctor result, persisted
  // verbatim by POST /api/servers/:name/isolation/doctor).
  verified?: boolean;
  checks?: { id: string; status: 'pass' | 'fail' | 'unknown'; detail: string }[];
  probedAt?: string;
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
    return cleanup === 'pending' || cleanup === 'done' || cleanup === 'failed' || cleanup === 'skipped';
  }
  if (kind === 'verification') {
    // Issue #29 Step 2 C: now that the doctor actually writes this variant
    // (isolationDoctor.ts's runIsolationDoctor via POST
    // /api/servers/:name/isolation/doctor), require the shape it always
    // produces — `verified` a boolean and `checks` an array — rather than
    // just the bare discriminant. A malformed/truncated body is treated the
    // same as unavailable (see isolationReportUnavailable below), not
    // silently rendered with undefined fields.
    //
    // Step 2 review, Minor #5: `Array.isArray(checks)` alone let a value
    // like `[null]` or `[{}]` through — OverviewSection.tsx reads
    // `c.status`/`c.id` off every entry unconditionally (see its
    // `failedOrUnknownChecks` filter/map), which throws on a non-object
    // entry. Each entry is now required to be a non-array object carrying
    // `id`/`detail` as strings and `status` as one of the three known
    // values; a single malformed entry fails the whole report closed
    // (unavailable), matching this function's existing "any unrecognized
    // shape → invalid" contract rather than rendering a partially-broken
    // checks list.
    const verified = (value as { verified?: unknown }).verified;
    const checks = (value as { checks?: unknown }).checks;
    return typeof verified === 'boolean' && Array.isArray(checks) && checks.every(isValidIsolationCheck);
  }
  return false;
}

function isValidIsolationCheck(value: unknown): value is { id: string; status: 'pass' | 'fail' | 'unknown'; detail: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { id, status, detail } = value as { id?: unknown; status?: unknown; detail?: unknown };
  return typeof id === 'string' && typeof detail === 'string'
    && (status === 'pass' || status === 'fail' || status === 'unknown');
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

// Review round (Important finding 4): the cleanup-report counterpart to
// hasIsolationReportField above, split into its own field on the same GET
// /:name response — see IsolationReport's doc comment.
export function hasIsolationCleanupReportField(body: unknown): body is { isolationCleanupReport: unknown } {
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, 'isolationCleanupReport');
}

async function fetchInstallStatus(encodedName: string): Promise<{ status: InstallStatusResponse | null; error: 'offline' | 'failed' | null; detail?: string }> {
  try {
    const r = await api<InstallStatusResponse | { error: string; code?: string; detail?: string }>(`/servers/${encodedName}/install-status`);
    if ('error' in r) return { status: null, error: r.error === 'agent_unreachable' ? 'offline' : 'failed', ...(r.code === 'macos_local_network_permission' ? { detail: r.detail } : {}) };
    return { status: r, error: null };
  } catch {
    return { status: null, error: 'failed' };
  }
}

interface UseServerDetailResult {
  server: Server | null;
  servers: Server[];
  status: ServerStatus | null;
  installStatus: InstallStatusResponse | null;
  /** install-status を取得できなかった理由。'offline' はハブが到達不能（503）と判定した場合。 */
  installStatusError: 'offline' | 'failed' | null;
  localNetworkDetail: string | undefined;
  sessions: Session[];
  sessionsState: 'loading' | 'error' | 'partial' | 'ready';
  sessionsReason: string | null;
  muxFetchState: 'loading' | 'ready' | 'error';
  muxReason: string | null;
  windowById: Map<number, WindowIndexEntry>;
  taskById: Map<number, { title?: string }>;
  /** Whether the hub can reach this server's mux driver (detail API `mux`); 'unknown' until fetched or when the body is not understood. */
  muxDriverStatus: MuxDriverStatus;
  isolationReport: IsolationReport | null;
  // Review round (Important finding 4): the cleanup-outcome counterpart to
  // isolationReport above — parsed independently from its own
  // isolationCleanupReport response field, since the server now persists it
  // in a separate column (see IsolationReport's doc comment).
  isolationCleanupReport: IsolationReport | null;
  // Issue #29 review, Important finding 3: true when this server declares
  // isolationIntent but the detail fetch that would carry isolationReport
  // failed outright or came back in a shape this hook doesn't recognize —
  // distinguishes "we don't know whether cleanup succeeded" from "cleanup
  // succeeded" (isolationReport === null), which a bare `.catch(() => null)`
  // could not: both looked identical to the UI before this field existed.
  isolationReportUnavailable: boolean;
  // Review round (Important finding 4): same "fetch failed / unrecognized
  // shape" distinction as isolationReportUnavailable above, but for the
  // isolationCleanupReport field specifically — a malformed cleanup field
  // must not be silently read as "no cleanup report", independent of
  // whether the verification field parsed fine.
  isolationCleanupReportUnavailable: boolean;
  windowMetaError: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useServerDetail(serverName: string | null): UseServerDetailResult {
  // サーバー一覧・接続状態は ServerStatusProvider から供給（グローバルにポーリング済み）。
  // ここでは install-status とセッション一覧のみ、この画面固有に取得する。
  const { servers, statuses, refresh: refreshStatuses } = useServerStatuses();
  const connectionRef = useRef({ servers, statuses });
  connectionRef.current = { servers, statuses };
  const [installStatus, setInstallStatus] = useState<InstallStatusResponse | null>(null);
  const [installStatusError, setInstallStatusError] = useState<'offline' | 'failed' | null>(null);
  const [localNetworkDetail, setLocalNetworkDetail] = useState<string | undefined>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionsState, setSessionsState] = useState<'loading' | 'error' | 'partial' | 'ready'>('loading');
  const [sessionsReason, setSessionsReason] = useState<string | null>(null);
  const [muxFetchState, setMuxFetchState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [muxReason, setMuxReason] = useState<string | null>(null);
  const overviewGenRef = useRef(0);
  const sessionServerRef = useRef<string | null>(null);
  const [allProjects, setAllProjects] = useState<Array<{ windows?: Window[] }>>([]);
  const [allTasks, setAllTasks] = useState<Array<{ id: number; title?: string; windows?: Window[] }>>([]);
  const [isolationReport, setIsolationReport] = useState<IsolationReport | null>(null);
  const [isolationReportUnavailable, setIsolationReportUnavailable] = useState(false);
  const [isolationCleanupReport, setIsolationCleanupReport] = useState<IsolationReport | null>(null);
  const [isolationCleanupReportUnavailable, setIsolationCleanupReportUnavailable] = useState(false);
  const [muxDriverStatus, setMuxDriverStatus] = useState<MuxDriverStatus>('unknown');
  const [windowMetaError, setWindowMetaError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Issue #29 review (8th pass), Important finding 3: fetchAll's four
  // requests are all awaited via Promise.all with no guard against a
  // serverName switch that happens while they're still in flight — an
  // earlier request for server A resolving AFTER a later request for
  // server B (e.g. A's install-status endpoint is slow, B's are all fast)
  // would overwrite B's freshly-set installStatus/sessions/isolationReport
  // with A's stale data, with no error surfaced. Mirrors the generation-ref
  // pattern already used for the same "later call must win" requirement in
  // useAddWindowModal's openQuickAddWindow/closeQuickAddWindow (rather than
  // useApi's AbortController-less `cancelled` boolean, which only guards a
  // single in-flight call per mount and doesn't fit this hook's
  // externally-triggered `refresh()` re-entrancy).
  const fetchGenRef = useRef(0);

  // 'unreachable' = the status probe says the agent is offline, 'unknown' = the probe itself failed.
  // `detailRequest` lets fetchAll share its own GET /servers/:name instead of asking twice.
  const refreshOverview = useCallback((
    mode: 'fetch' | 'unreachable' | 'unknown',
    detailRequest?: Promise<{ status: number; body: unknown }>,
  ) => {
    const gen = ++overviewGenRef.current;
    if (!serverName) return;
    const reason = mode === 'unreachable' ? 'agent_unreachable' : mode === 'unknown' ? 'status_unknown' : null;
    setMuxDriverStatus('unknown');
    setSessionsState(mode === 'fetch' ? 'loading' : 'error');
    setSessionsReason(reason);
    setMuxFetchState(mode === 'fetch' ? 'loading' : 'error');
    setMuxReason(reason);
    if (mode !== 'fetch') {
      setSessions((prev) => prev.map((session) => ({ ...session, stale: true })));
      return;
    }
    void fetchSessionListing<Session>(serverName).then((result) => {
      if (overviewGenRef.current !== gen) return;
      setSessions((prev) => keepUnavailableKinds(prev, result));
      setSessionsState(sessionListingState(result));
      setSessionsReason(result.unavailable.map((item) => item.reason).join(', ') || null);
    }, (error: unknown) => {
      if (overviewGenRef.current !== gen) return;
      setSessions((prev) => prev.map((session) => ({ ...session, stale: true })));
      setSessionsState('error');
      setSessionsReason(error instanceof SessionListingError ? error.reason : null);
    });
    void (detailRequest ?? apiWithStatus<unknown>(`/servers/${encodeURIComponent(serverName)}`)).then((result) => {
      if (overviewGenRef.current !== gen) return;
      const body = result.body && typeof result.body === 'object' ? result.body as { mux?: unknown; error?: unknown } : null;
      const mux = body?.mux ?? null;
      const parsed = parseMuxDriverStatus(mux);
      const muxReasonValue = mux && typeof mux === 'object' ? (mux as { reason?: unknown }).reason : undefined;
      if (result.status < 200 || result.status >= 300 || parsed === 'unknown') {
        setMuxFetchState('error');
        setMuxReason(typeof body?.error === 'string' ? body.error : typeof muxReasonValue === 'string' ? muxReasonValue : null);
        return;
      }
      setMuxDriverStatus(parsed);
      setMuxFetchState('ready');
      setMuxReason(typeof muxReasonValue === 'string' ? muxReasonValue : null);
    }, () => {
      if (overviewGenRef.current !== gen) return;
      setMuxFetchState('error');
      setMuxReason(null);
    });
  }, [serverName]);

  const fetchAll = useCallback(async () => {
    if (!serverName) return;
    const gen = ++fetchGenRef.current;
    // Issue #29 review (8th pass), Important finding 3: reset the
    // per-server fields synchronously before the first await — otherwise,
    // while this fetch is in flight, the panel keeps showing the PREVIOUS
    // server's installStatus/sessions/isolationReport under the new
    // server's name (e.g. switching from an isolated server to a
    // non-isolated one would flash the old isolation warning against the
    // new server until the fetch resolves).
    setInstallStatus(null);
    setInstallStatusError(null);
    setLocalNetworkDetail(undefined);
    if (sessionServerRef.current !== serverName) setSessions([]);
    sessionServerRef.current = serverName;
    setIsolationReport(null);
    setIsolationReportUnavailable(false);
    setIsolationCleanupReport(null);
    setIsolationCleanupReportUnavailable(false);
    setWindowMetaError(false);
    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(serverName);
      const detailRequest = apiWithStatus<unknown>(`/servers/${encoded}`);
      const knownServer = connectionRef.current.servers.find((s) => s.name === serverName);
      const agentOffline = knownServer?.type === 'agent' && connectionRef.current.statuses[serverName]?.status === 'offline';
      refreshOverview(agentOffline ? 'unreachable' : 'fetch', detailRequest);
      // Issue #29 review, Important finding 3: the isolationReport fetch
      // used to swallow every failure (network error, 4xx/5xx, malformed
      // body) into a bare `null` via `.catch(() => null)` — indistinguishable
      // from "cleanup completed cleanly, no report to show". A server
      // declaring isolationIntent needs that distinction surfaced (see
      // isolationReportUnavailable below), so this uses apiWithStatus and
      // treats non-2xx / a thrown error / an unrecognized body shape as
      // "unavailable", not as "no warning".
      // Window metadata (projects/tasks) fetched in parallel with the main
      // requests so they don't wait for install-status / sessions to finish.
      void Promise.allSettled([
        api<Array<{ windows?: Window[] }>>('/projects'),
        api<Array<{ id: number; title?: string; windows?: Window[] }>>('/tasks'),
      ]).then(([projResult, taskResult]) => {
        if (fetchGenRef.current !== gen) return;
        const projectsOk = projResult.status === 'fulfilled' && Array.isArray(projResult.value);
        const tasksOk = taskResult.status === 'fulfilled' && Array.isArray(taskResult.value);
        setAllProjects(projectsOk ? projResult.value : []);
        setAllTasks(tasksOk ? taskResult.value : []);
        setWindowMetaError(!projectsOk || !tasksOk);
      });
      const mainPromise = Promise.all([
        refreshStatuses(),
        // 到達不能なサーバー（503 agent_unreachable）でも詳細全体を落とさず、失敗の種類を区別して返す
        fetchInstallStatus(encoded),
        detailRequest.catch(() => null),
      ]);
      const [srvList, installRes, detailResult] = await mainPromise;
      if (!srvList.some((s) => s.name === serverName)) throw new Error(`Server "${serverName}" not found`);
      // Issue #29 review (8th pass), Important finding 3: a newer fetchAll
      // call (triggered by a serverName change or an external refresh())
      // may have already started and even completed while this one was
      // awaiting — discard this response rather than let it clobber the
      // newer one's state.
      if (fetchGenRef.current !== gen) return;
      setInstallStatus(installRes.status);
      setInstallStatusError(installRes.error);
      setLocalNetworkDetail(installRes.detail);
      // Review round (Important finding 4): the server now returns the
      // verification report and the cleanup report as two independent
      // fields on the same body — parsed here with the exact same
      // "unrecognized shape -> unavailable" contract, once per field, so a
      // malformed one never masks the other.
      function parseReportField(
        fieldName: 'isolationReport' | 'isolationCleanupReport',
      ): { report: IsolationReport | null; unavailable: boolean } {
        if (detailResult === null || detailResult.status < 200 || detailResult.status >= 300) {
          return { report: null, unavailable: true };
        }
        const body = detailResult.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, fieldName)) {
          // Issue #29 review (5th pass), Important finding 3: a 2xx body
          // that isn't a non-array object owning the field at all (null, an
          // array, a scalar, or an object missing the field) is not a shape
          // this hook understands — treated as unavailable rather than
          // risking a property access on a non-object body.
          return { report: null, unavailable: true };
        }
        const raw = (body as Record<string, unknown>)[fieldName];
        if (typeof raw === 'string' && raw) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            return isValidIsolationReport(parsed) ? { report: parsed, unavailable: false } : { report: null, unavailable: true };
          } catch {
            return { report: null, unavailable: true };
          }
        }
        if (raw != null) {
          // Present but neither a string nor null/undefined (e.g. a stray
          // number/object from a malformed response) — not a shape this
          // hook can parse as a report.
          return { report: null, unavailable: true };
        }
        return { report: null, unavailable: false };
      }


      const verification = parseReportField('isolationReport');
      const cleanup = parseReportField('isolationCleanupReport');
      // Unavailability only matters (as UI-visible uncertainty) for a server
      // that actually declared isolation — a server that never opted in has
      // no promise to fail to verify.
      const declaredIsolated = srvList.find((s) => s.name === serverName)?.isolationIntent ?? false;
      setIsolationReport(verification.report);
      setIsolationReportUnavailable(declaredIsolated && verification.unavailable);
      setIsolationCleanupReport(cleanup.report);
      setIsolationCleanupReportUnavailable(declaredIsolated && cleanup.unavailable);
    } catch (err: unknown) {
      if (fetchGenRef.current === gen) setError((err as Error).message);
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, [serverName, refreshStatuses, refreshOverview]);

  useEffect(() => {
    void fetchAll();
    return () => { fetchGenRef.current += 1; overviewGenRef.current += 1; };
  }, [fetchAll]);

  const server = servers.find((s) => s.name === serverName) ?? null;
  const status = serverName ? statuses[serverName] ?? null : null;

  const monitoredStatus = status?.status;
  const isAgent = server?.type === 'agent';
  const previousConnection = useRef<{ name: string | null; status: string | undefined }>({ name: null, status: undefined });
  useEffect(() => {
    if (!isAgent) {
      previousConnection.current = { name: serverName, status: undefined };
      return;
    }
    if (monitoredStatus === 'checking' || !monitoredStatus) return;
    const previous = previousConnection.current;
    previousConnection.current = { name: serverName, status: monitoredStatus };
    if (previous.name === serverName && previous.status === monitoredStatus) return;
    if (monitoredStatus === 'offline') refreshOverview('unreachable');
    else if (monitoredStatus === 'error') refreshOverview('unknown');
    else if (monitoredStatus === 'online' && previous.name === serverName && (previous.status === 'offline' || previous.status === 'error')) refreshOverview('fetch');
  }, [serverName, monitoredStatus, isAgent, refreshOverview]);

  const windowById = useMemo(() => buildWindowIndex(allProjects, allTasks, null), [allProjects, allTasks]);
  const taskById = useMemo(() => {
    const map = new Map<number, { title?: string }>();
    for (const t of allTasks) map.set(t.id, t);
    return map;
  }, [allTasks]);

  return {
    server, servers, status, installStatus, installStatusError, localNetworkDetail, sessions, sessionsState,
    windowById, taskById, sessionsReason, muxFetchState, muxReason,
    muxDriverStatus,
    isolationReport, isolationReportUnavailable,
    isolationCleanupReport, isolationCleanupReportUnavailable,
    windowMetaError,
    loading, error, refresh: fetchAll,
  };
}
