import type { FastifyPluginCallback } from 'fastify';
import { execSync } from 'child_process';
import os from 'os';
import type { IServerRepository, MuxRuntime } from './Server';
import type { TmuxClient, TmuxSession } from '../tmux/TmuxClient';
import type { AgentInstaller, InstallProgress } from './agent-deploy/AgentInstaller';
import type { AgentBundler } from './agent-deploy/AgentBundler';
import type { TransportFactory } from './transport/TransportFactory';
import type { HarnessInstaller, HarnessInstallProgress, HarnessInstallResult } from './agent-deploy/HarnessInstaller';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IWindowRepository } from '../windows/SqliteWindowRepository';
import { parseTmuxVersion, parseNodeVersion, parseHarnessCheck, parseTailscaleCheck, parseChromiumInstall } from './installStatusParsers';
import { findChromiumBinaryCommand } from './agent-deploy/BrowserRuntimeInstaller';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';
import type { TmuxInstaller } from './agent-deploy/TmuxInstaller';
import type { AuditLogService } from '../../shared/audit/AuditLogService';
import { recordAuditBestEffort } from '../../shared/audit/recordAuditBestEffort';
import { OPERATOR_PRINCIPAL, type Principal } from '../../shared/auth/Principal';
import type { KeyedMutex } from '../../shared/keyedMutex';

// ─── Tailscale / network helpers ───

function getTailscaleDnsName(): string | null {
  try {
    const tsJson = execSync('tailscale status --self --json 2>/dev/null', { timeout: 5000 }).toString();
    const tsData = JSON.parse(tsJson);
    const dnsName = (tsData.Self?.DNSName || '').replace(/\.$/, '');
    return dnsName || null;
  } catch {
    return null;
  }
}

function getTailscaleIp(): string | null {
  try {
    return execSync('tailscale ip -4 2>/dev/null', { timeout: 5000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

function getLanIps(): string[] {
  const results: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) results.push(iface.address);
    }
  }
  return results;
}

// ─── Types ───

export interface ServersRouteOptions {
  serverRepo: IServerRepository;
  tmux: TmuxClient;
  transportFactory: TransportFactory;
  agentInstaller?: AgentInstaller;
  agentBundler?: AgentBundler;
  harnessInstaller?: HarnessInstaller;
  tmuxInstaller?: TmuxInstaller;
  projectRepo?: IProjectRepository;
  projectServerRepo?: IProjectServerRepository;
  // Issue #29 review, Critical finding 1: used by the isolation_intent
  // false->true gate to detect windows that may already hold injected
  // credentials (window_type='agent', or any task-owned window) on the
  // target server before declaring it isolated. Required (not optional,
  // unlike most other cross-module deps in this bag) — this is a security
  // gate, and an unwired dependency here must fail to compile/start rather
  // than silently fail open by skipping the check.
  windowRepo: IWindowRepository;
  webhookToken: string;
  uiToken: string;
  harnessPrefix?: string;
  // Issue #29 review (6th pass), Important finding 3: serializes the
  // isolation_intent false->true check-through-commit span below against the
  // sessions/windows/panes creation routes' server-refetch-through-tmux-create
  // span (see modules/tmux/routes/sessions.ts), both keyed by server name —
  // a shared instance wired once in buildServer.ts, not a locally-created
  // fallback, or the two route files would each serialize against themselves
  // only and the race between them would remain open. Required (not
  // optional) for the same reason windowRepo above is: an unwired dependency
  // here must fail to compile/start rather than silently reopen the race.
  serverIsolationMutex: KeyedMutex;
  // Best-effort (Issue #29 review, Important finding 1): records the
  // isolation_intent auto-clear PUT /api/servers/:name performs when a
  // server's effective type moves off 'agent'. Optional — matches every
  // other recordAuditBestEffort() call site in this codebase (see that
  // function's own doc comment).
  auditLogService?: AuditLogService;
}

// ─── Plugin ───

const serversRoutes: FastifyPluginCallback<ServersRouteOptions> = (fastify, opts, done) => {
  const { serverRepo, tmux, transportFactory, agentInstaller, agentBundler, harnessInstaller, tmuxInstaller, projectRepo, projectServerRepo, windowRepo, webhookToken, uiToken, harnessPrefix, auditLogService, serverIsolationMutex } = opts;

  // Issue #29 review, Important finding 1: a false->true isolation_intent
  // transition must actually purge a previously-distributed operator token
  // from the target server, not just flip the DB flag — otherwise a server
  // labeled "isolated" can still be holding a live full-access token. Runs
  // the same HarnessInstaller.install() path the harness/install route uses,
  // forcing isolationIntent:true (withholds --ui-token, forces
  // --purge-operator-token — see HarnessInstaller.ts / setup.sh). This is
  // best-effort by design: "intent is a declaration, verification is the
  // doctor's job" (a later task) means a cleanup failure here must NOT fail
  // the PUT or silently pretend the server is clean — it's recorded honestly
  // in isolation_report so the UI can surface it instead of faking safety.
  // Issue #29 review, Important finding 2: returns the cleanup outcome so
  // the PUT handler can surface it to the caller as `isolationCleanup` —
  // previously this result was recorded ONLY in isolation_report (a
  // detail-only, list-excluded field with no route to read it back), so an
  // operator declaring isolation had no way to learn a purge had silently
  // failed short of inspecting the DB directly.
  async function attemptIsolationCleanup(serverName: string, principal: Principal): Promise<'done' | 'failed' | 'skipped'> {
    const at = new Date().toISOString();
    // Issue #29 review, Important finding 3: `kind: 'cleanup'` distinguishes
    // this synchronous remote-token-purge outcome from the isolation
    // doctor's future `kind: 'verification'` writes to the same column —
    // see Server.ts's isolationReport doc comment.
    let report: Record<string, unknown>;

    if (!harnessInstaller) {
      report = { kind: 'cleanup', cleanup: 'skipped', reason: 'harness_installer_unavailable', at };
    } else {
      const srv = serverRepo.findByName(serverName);
      const sshHost = srv?.sshHost || srv?.host;
      if (!srv || !sshHost) {
        report = { kind: 'cleanup', cleanup: 'skipped', reason: 'no_ssh_host', at };
      } else {
        try {
          const result = await harnessInstaller.install(sshHost, {
            webhookToken,
            uiToken,
            serverName: srv.name,
            prefix: harnessPrefix,
            isolationIntent: true,
          });
          report = result.success
            ? { kind: 'cleanup', cleanup: 'done', at }
            : { kind: 'cleanup', cleanup: 'failed', error: result.error, at };
        } catch (err: unknown) {
          report = { kind: 'cleanup', cleanup: 'failed', error: (err as Error).message, at };
        }
      }
    }

    serverRepo.updateIsolationReport?.(serverName, JSON.stringify(report));
    recordAuditBestEffort(auditLogService, {
      actorClass: principal.class,
      actorId: principal.id,
      event: 'server.isolation_intent.cleanup_attempted',
      detail: { serverName, ...report },
    });
    return report.cleanup as 'done' | 'failed' | 'skipped';
  }

  // Issue #29 review (final pass), Important finding 2: a true->true PUT
  // (isolationIntent already true, requested again unchanged) used to be a
  // complete no-op — including when the ORIGINAL false->true transition's
  // cleanup never actually completed (crashed mid-attempt, or genuinely
  // failed/was skipped). That left the row stuck at
  // `isolation_intent=1` with a report that never resolves to "done", and
  // nothing ever retries it: the operator's only way to notice was reading
  // `isolation_report` directly. A true->true request now re-attempts
  // cleanup unless the last recorded outcome was already `'done'` — a
  // malformed/unparseable report is treated the same as "not done" (retry),
  // since there is no report content that can be trusted as a completed
  // cleanup other than an explicit `cleanup: 'done'`.
  function isolationCleanupNeedsRetry(reportJson: string | null): boolean {
    if (!reportJson) return true;
    try {
      const parsed = JSON.parse(reportJson) as { cleanup?: unknown };
      return parsed.cleanup !== 'done';
    } catch {
      return true;
    }
  }

  // ── GET /api/servers ──
  fastify.get('/api/servers', async () => {
    // Bundle content hash (what deployed agents report at /health) — not the hub git
    // SHA. Read-only accessor: never triggers a build; null until the bundle exists.
    const hubBundleHash = agentBundler ? agentBundler.getBundleHashIfBuilt() : null;
    // isolationReport is a detail-only field (full JSON doctor result) — the
    // list endpoint exposes only the intent flag and last-check timestamp,
    // matching ServerConfig.isolationReport's own doc comment.
    return serverRepo.findAll().map(({ agentToken, isolationReport, ...rest }) => ({
      ...rest,
      hasAgentToken: agentToken != null,
      hubVersion: hubBundleHash,
    }));
  });

  // ── GET /api/servers/:name ──
  // Issue #29 review, Important finding 2: the detail-only counterpart to
  // the list route above — this is the one place isolationReport (the
  // cleanup/verification outcome JSON, see Server.ts's doc comment) is ever
  // returned over the API. Access control is the same default-deny the rest
  // of this route file relies on (no per-route principal check here matches
  // every other route in this file); nothing operator-sensitive beyond what
  // PUT/DELETE on the same path already exposes to the same caller class.
  fastify.get<{ Params: { name: string } }>('/api/servers/:name', async (request, reply) => {
    const srv = serverRepo.findByName(request.params.name);
    if (!srv) return reply.status(404).send({ error: 'Server not found' });
    const hubBundleHash = agentBundler ? agentBundler.getBundleHashIfBuilt() : null;
    const { agentToken, ...rest } = srv;
    return { ...rest, hasAgentToken: agentToken != null, hubVersion: hubBundleHash };
  });

  // ── POST /api/servers ──
  fastify.post('/api/servers', async (request, reply) => {
    const { name, type, host, agentPort, agentToken, autoInstall, muxRuntime } = request.body as {
      name?: string;
      type?: string;
      host?: string;
      agentPort?: number;
      agentToken?: string;
      autoInstall?: boolean;
      muxRuntime?: string;
    };
    const validMuxRuntime = muxRuntime || undefined;
    if (validMuxRuntime && validMuxRuntime !== 'system' && validMuxRuntime !== 'managed')
      return reply.status(400).send({ error: 'muxRuntime must be "system" or "managed"' });
    if (!name) return reply.status(400).send({ error: 'Server name required' });
    if (!/^[\w.@ -]{1,64}$/.test(name)) return reply.status(400).send({ error: 'Invalid server name' });

    if (autoInstall && agentInstaller) {
      if (!host) return reply.status(400).send({ error: 'Host (user@host) required' });
      if (serverRepo.findByName(name))
        return reply.status(409).send({ error: 'Server already exists' });

      const steps: InstallProgress[] = [];
      const result = await agentInstaller.install(host, (p) => steps.push(p), validMuxRuntime);

      if (result.success) {
        serverRepo.create(name, 'agent', result.host, result.port, result.token, result.version, host, validMuxRuntime as MuxRuntime | undefined);
        return { ok: true, type: 'agent', steps, startMethod: result.startMethod };
      }

      return reply.status(500).send({ error: result.error, steps });
    }

    if (!type || !['local', 'agent'].includes(type))
      return reply.status(400).send({ error: 'Type must be "local" or "agent"' });
    if (type === 'agent') {
      if (!host) return reply.status(400).send({ error: 'Host required for agent servers' });
      if (!agentPort) return reply.status(400).send({ error: 'Port required for agent servers' });
      if (!agentToken) return reply.status(400).send({ error: 'Token required for agent servers' });
    }
    if (serverRepo.findByName(name))
      return reply.status(409).send({ error: 'Server already exists' });
    try {
      serverRepo.create(name, type, host, agentPort, agentToken, undefined, undefined, validMuxRuntime as MuxRuntime | undefined);
      return { ok: true };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── PUT /api/servers/:name ──
  fastify.put<{ Params: { name: string } }>(
    '/api/servers/:name',
    // Issue #29 review (6th pass), Important finding 3: the entire
    // read-check-commit span of this handler runs inside the per-server-name
    // mutex — not just the false->true branch — so it serializes against
    // itself (two overlapping PUTs on the same server) as well as against
    // the sessions/windows/panes creation routes' server-refetch span (see
    // sessions.ts). See serverIsolationMutex's doc comment on
    // ServersRouteOptions above.
    async (request, reply) => serverIsolationMutex.withLock(request.params.name, async () => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const { type, host, agentPort, agentToken, sshHost, muxRuntime: putMux, isolationIntent } = request.body as {
        type?: string; host?: string; agentPort?: number; agentToken?: string; sshHost?: string; muxRuntime?: string; isolationIntent?: boolean;
      };
      const validPutMux = putMux || undefined;
      if (validPutMux && validPutMux !== 'system' && validPutMux !== 'managed')
        return reply.status(400).send({ error: 'muxRuntime must be "system" or "managed"' });
      // Issue #29 review, Important finding 2: isolationIntent must be an
      // actual boolean, not merely truthy — `"false"` (a string) is truthy
      // in JS and would otherwise be persisted as `true` by
      // serverRepo.updateIsolationIntent (which trusts its caller to have
      // already validated the type). Runtime-checked here because this
      // value crosses the HTTP boundary as untyped JSON; the `boolean`
      // annotation on the destructured body above is a compile-time-only
      // assertion that does not survive `request.body as {...}`.
      if (isolationIntent !== undefined && typeof isolationIntent !== 'boolean') {
        return reply.status(400).send({ error: 'isolationIntent must be a boolean' });
      }
      // isolation_intent is only meaningful for agent servers (Issue #29
      // design v2): a "local" server always shares the hub process's own
      // credential store, so declaring it "isolated" would be a lie the
      // credential-distribution gates (TaskPaneEnvironmentService,
      // HarnessInstaller) could never actually honor. Reject DECLARING
      // isolation (isolationIntent: true) for a non-agent effective type at
      // the API boundary rather than silently accepting and ignoring it.
      //
      // Issue #29 review, Important finding 1: explicitly setting
      // isolationIntent: false alongside a type change to 'local' is NOT
      // rejected here (unlike the `true` case above) — it's the one
      // combination a caller trying to undo isolation on a
      // type-transitioning server needs to be able to send, and the old
      // code rejected it purely because isolationIntent was present at all
      // when effectiveType !== 'agent', with no way to explicitly express
      // "and clear it too" in the same request.
      const effectiveType = (type || srv.type) as 'local' | 'agent';
      if (effectiveType !== 'agent' && isolationIntent === true) {
        return reply.status(400).send({ error: 'isolationIntent is only settable for agent servers' });
      }
      // Issue #29 review, Critical finding 1: a false->true isolation_intent
      // transition previously only cleaned up the persisted operator-token
      // config (HarnessInstaller purge via attemptIsolationCleanup below) —
      // it never checked whether a window on this server might already be
      // running with a credential-bearing environment already injected into
      // its live process (AZITO_UI_TOKEN / AZITO_AGENT_TOKEN / AZITO_SECRET_*
      // — see TaskPaneEnvironmentService). That pane keeps holding the old
      // credentials in its environment for as long as it runs, regardless of
      // what the DB says. Draining/recreating those panes automatically is
      // too complex to do safely here, so this fails closed instead: reject
      // the transition with 409 while any window row is registered for this
      // server that could have received credentials (window_type='agent', or
      // any task-owned window — TaskPaneEnvironmentService injects into both
      // primary and secondary task windows, not just the primary one).
      // Liveness is NOT verified against tmux (a real "is this pane still
      // running" check is costly and, more importantly, a false negative
      // here would silently defeat the whole gate) — presence of the DB row
      // alone is treated as "may still be live", which is the conservative
      // direction to be wrong in.
      // Issue #29 review (6th pass), Important finding 2: the risky-window /
      // live-session checks just below inspect the server's CURRENT
      // connection info (srv.host / srv.sshHost / agentPort / agentToken —
      // read via `srv`, fetched before this PUT's own serverRepo.update()
      // runs), while a false->true transition's cleanup
      // (attemptIsolationCleanup) re-fetches the row AFTER the update and
      // therefore purges against whatever connection info THIS SAME request
      // just wrote. Accepting both a connection-info change and a
      // false->true transition in one PUT would inspect one endpoint and
      // clean up a different one — a credential-bearing session on the NEW
      // endpoint would never be checked, and the DB would still end up
      // marked isolated. Reject the combination outright; the caller must
      // confirm the connection target in one PUT, then declare isolation in
      // a follow-up PUT once the check/cleanup can agree on which endpoint
      // they're both looking at.
      // Issue #29 review (7th pass), Important finding 2: a `type`
      // (local<->agent) or `muxRuntime` (system<->managed) change is just as
      // much an "endpoint the check/cleanup could disagree about" as
      // host/sshHost/agentPort/agentToken — a local->agent switch changes
      // which transport (and therefore which live pane/session set) is being
      // inspected, and a muxRuntime switch changes which tmux runtime the
      // session-liveness check above (`tmux.listSessions`) actually talks to.
      // Both were missing from this list, so a false->true isolation
      // transition combined with either change slipped past the guard above
      // and inspected/cleaned up against the OLD endpoint while committing
      // isolation for the NEW one.
      const connectionInfoChanged =
        (type !== undefined && effectiveType !== srv.type) ||
        (validPutMux !== undefined && validPutMux !== srv.muxRuntime) ||
        (host !== undefined && host !== srv.host) ||
        (sshHost !== undefined && sshHost !== srv.sshHost) ||
        (agentPort !== undefined && agentPort !== srv.agentPort) ||
        (agentToken !== undefined && agentToken !== srv.agentToken);
      if (effectiveType === 'agent' && isolationIntent === true && isolationIntent !== srv.isolationIntent && connectionInfoChanged) {
        return reply.status(400).send({
          error: 'isolation_intent_transition_with_connection_change',
          message: '接続先情報の変更と隔離の有効化（isolationIntent: false→true）は同じリクエストで指定できません。先に接続先を確定させてから、別のリクエストで隔離を有効化してください。',
        });
      }
      if (effectiveType === 'agent' && isolationIntent === true && isolationIntent !== srv.isolationIntent) {
        const riskyWindows = windowRepo
          .findByServer(request.params.name)
          .filter((w) => w.windowType === 'agent' || w.taskId !== null);
        if (riskyWindows.length > 0) {
          return reply.status(409).send({
            error: 'isolation_intent_blocked_by_windows',
            message: `${riskyWindows.length} 件のウィンドウがこのサーバー上に登録されているため隔離を有効化できません。対象ウィンドウを閉じてから再度有効化してください。`,
            windowCount: riskyWindows.length,
          });
        }
        // Issue #29 review (4th pass), Critical finding 1: the DB `windows`
        // table only covers windows AZITO itself created and is still
        // tracking — it says nothing about a session a human (or another
        // process) created directly on this server via the generic tmux
        // session/window/pane routes (`modules/tmux/routes/sessions.ts`),
        // which — before this same review round's fix to those routes —
        // could have injected AZITO_UI_TOKEN into a live pane with no
        // corresponding `windows` row at all. A live tmux session is
        // therefore an independent signal from the DB check above, checked
        // in addition to it, not instead of it. Listing failure is treated
        // the same conservative way as the DB check: unable to prove the
        // server is clean means fail closed (409), not fail open.
        let liveSessions: TmuxSession[];
        try {
          liveSessions = await tmux.listSessions(srv);
        } catch (err: unknown) {
          return reply.status(409).send({
            error: 'isolation_intent_blocked_by_session_check_failure',
            message: `隔離対象サーバーの tmux セッション一覧取得に失敗したため、安全側に倒して隔離を有効化できません（${(err as Error).message}）。サーバーの疎通を確認してから再度お試しください。`,
          });
        }
        if (liveSessions.length > 0) {
          return reply.status(409).send({
            error: 'isolation_intent_blocked_by_live_sessions',
            message: `${liveSessions.length} 件の稼働中 tmux セッションがこのサーバー上に存在するため隔離を有効化できません。セッションを終了してから再度有効化してください。`,
            sessionCount: liveSessions.length,
          });
        }
      }
      // Issue #29 review, Important finding 2: set only when
      // attemptIsolationCleanup actually runs in this request (see below) —
      // stays undefined, and therefore omitted from the response, otherwise.
      let isolationCleanup: 'done' | 'failed' | 'skipped' | undefined;
      try {
        serverRepo.update(
          request.params.name,
          type || srv.type,
          host ?? srv.host ?? undefined,
          agentPort ?? srv.agentPort ?? undefined,
          agentToken ?? srv.agentToken ?? undefined,
          sshHost ?? srv.sshHost ?? undefined,
          (validPutMux as MuxRuntime | undefined) ?? srv.muxRuntime,
        );
        if (effectiveType !== 'agent') {
          // Issue #29 review, Important finding 1: an isolation-invariant
          // auto-clear, not a mirror of the request body — a server whose
          // EFFECTIVE type is no longer 'agent' can never legitimately stay
          // isolated (see the rejection above for the reverse direction:
          // declaring isolation on a non-agent type is refused outright).
          // Runs UNCONDITIONALLY when the row was actually isolated,
          // regardless of whether this request even mentioned
          // isolationIntent — a plain `{ type: 'local' }` PUT with no
          // isolationIntent field at all must not leave `isolation_intent=1`
          // stranded on a row TaskPaneEnvironmentService/HarnessInstaller no
          // longer treat as isolatable in the first place (that class of
          // server only ever sees the credential-distribution gates as
          // "agent-type or not", so the previously-isolated intent becomes
          // meaningless dead state, not a preserved decision).
          if (srv.isolationIntent) {
            serverRepo.updateIsolationIntent(request.params.name, false);
            recordAuditBestEffort(auditLogService, {
              actorClass: (request.principal ?? OPERATOR_PRINCIPAL).class,
              actorId: (request.principal ?? OPERATOR_PRINCIPAL).id,
              event: 'server.isolation_intent.auto_cleared',
              detail: { serverName: request.params.name, reason: 'type_no_longer_agent' },
            });
          }
        } else if (isolationIntent !== undefined && isolationIntent !== srv.isolationIntent) {
          // Issue #29 review (3rd pass), Important finding 2: a no-op
          // true->true (or false->false) PUT used to call
          // updateIsolationIntent() unconditionally, which unconditionally
          // clears isolation_verified_at/isolation_report (see that method's
          // doc comment / SqliteServerRepository) even when nothing actually
          // changed. Since cleanup retry is currently only wired for the
          // false->true transition below, a same-value PUT silently erased an
          // existing report with no corresponding retry to regenerate it —
          // the UI's isolation notice would just go blank. Gate the call on
          // an actual value change; false->false is a complete no-op that
          // preserves the existing report (see the true->true branch below
          // for the same-value case in the OTHER direction, which is not a
          // no-op).
          const wasIsolated = srv.isolationIntent;
          serverRepo.updateIsolationIntent(request.params.name, isolationIntent);
          if (isolationIntent === true && !wasIsolated) {
            // Issue #29 review, Important finding 1: fire-and-forget would
            // race the response with the DB write it depends on reading
            // back (attemptIsolationCleanup re-fetches the row for its
            // sshHost) and would leave the caller with no way to learn the
            // outcome before the response returns — this is a declared
            // false->true transition, not a hot path, so awaiting it here is
            // the correct tradeoff (matches the design note: cleanup failure
            // must not fail the PUT, but the PUT should reflect a completed
            // attempt).
            isolationCleanup = await attemptIsolationCleanup(request.params.name, request.principal ?? OPERATOR_PRINCIPAL);
          }
        } else if (isolationIntent === true && srv.isolationIntent === true) {
          // Issue #29 review (final pass), Important finding 2: a true->true
          // request — same declared value, so `serverRepo.updateIsolationIntent`
          // is deliberately NOT called (it would reset the report back to the
          // pending marker for no reason, see that method's doc comment) —
          // still retries the cleanup attempt when the last recorded outcome
          // never actually resolved to 'done': a crash between the intent
          // commit and the cleanup write leaves `isolation_report` at the
          // pending marker (or, after startup recovery below runs, `'failed'`
          // with `reason: 'interrupted'`); a genuine remote failure also
          // leaves `'failed'`. Both are exactly the states an operator
          // re-submitting the same "isolate this server" request expects to
          // retry, not silently no-op forever. A `report: 'done'` (the only
          // fully-settled outcome) stays untouched, matching the pre-existing
          // true->true no-op for that case.
          if (isolationCleanupNeedsRetry(srv.isolationReport)) {
            isolationCleanup = await attemptIsolationCleanup(request.params.name, request.principal ?? OPERATOR_PRINCIPAL);
          }
        }
        transportFactory.invalidate(request.params.name);
        // Issue #29 review, Important finding 2: surfaces the cleanup
        // outcome directly in the PUT response — undefined (field omitted)
        // when no cleanup ran this request, so callers can distinguish "no
        // cleanup was attempted" from an actual result without probing
        // isolation_report separately.
        return { ok: true, ...(isolationCleanup !== undefined ? { isolationCleanup } : {}) };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }),
  );

  // ── POST /api/servers/:name/agent/install ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/agent/install',
    async (request, reply) => {
      if (!agentInstaller) return reply.status(501).send({ error: 'Agent installer not available' });

      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const sshHost = srv.sshHost || srv.host;
      if (!sshHost) return reply.status(400).send({ error: 'No SSH host configured for this server' });

      const steps: InstallProgress[] = [];
      const result = await agentInstaller.install(sshHost, (p) => steps.push(p), srv.muxRuntime);

      if (result.success) {
        serverRepo.update(srv.name, 'agent', result.host, result.port, result.token, sshHost, srv.muxRuntime);
        serverRepo.updateAgentVersion(srv.name, result.version);
        transportFactory.invalidate(srv.name);
        return { ok: true, steps, startMethod: result.startMethod };
      }

      return reply.status(500).send({ error: result.error, steps });
    },
  );

  // ── POST /api/servers/:name/harness/install ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/harness/install',
    async (request, reply) => {
      if (!harnessInstaller) return reply.status(501).send({ error: 'Harness installer not available' });

      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const { azito_url } = request.body as { azito_url?: string };

      if (azito_url && !/^https?:\/\/[\w.:\-[\]]+\/?$/.test(azito_url)) {
        return reply.status(400).send({ error: 'Invalid azito_url format' });
      }

      const steps: HarnessInstallProgress[] = [];
      let result: HarnessInstallResult;
      const installOptions = { azitoUrl: azito_url, webhookToken, uiToken, serverName: srv.name, prefix: harnessPrefix, isolationIntent: srv.isolationIntent };

      if (srv.type === 'local') {
        result = await harnessInstaller.installLocal(installOptions);
      } else {
        const sshHost = srv.sshHost || srv.host;
        if (!sshHost) return reply.status(400).send({ error: 'No SSH host configured for this server' });
        result = await harnessInstaller.install(sshHost, installOptions, (p) => steps.push(p));
      }

      if (!result.success) {
        return reply.status(500).send({ ok: false, steps: result.steps, error: result.error });
      }

      return { ok: true, steps: result.steps };
    },
  );

  // ── DELETE /api/servers/:name ──
  fastify.delete<{ Params: { name: string } }>(
    '/api/servers/:name',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      try {
        serverRepo.delete(request.params.name);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/servers/:name/status ──
  fastify.get<{ Params: { name: string } }>(
    '/api/servers/:name/status',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      try {
        // Bundle content hash (what agents report at /health), read without triggering
        // a build — this route is polled frequently and must stay cheap. Null (bundle
        // not built yet) keeps the pre-existing "unknown hub version" semantics.
        const tmuxVersionCmd = srv.muxRuntime === 'managed'
          ? '$HOME/.azito/tmux/bin/tmux -L azito -f $HOME/.azito/tmux/azito.conf -V'
          : 'tmux -V';
        const hubBundleHash = agentBundler ? agentBundler.getBundleHashIfBuilt() : null;
        if (srv.type === 'agent') {
          try {
            const res = await fetch(`http://${srv.host}:${srv.agentPort}/health`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return { status: 'offline' as const, tmux: false, message: `Agent returned ${res.status}` };
            const health = await res.json() as { version: string; pid: number; uptime: number };
            const versionMatch = hubBundleHash ? health.version === hubBundleHash : true;
            let tmuxAvailable = false;
            let tmuxVersion = '';
            try {
              const { stdout } = await tmux.execCommand(srv, tmuxVersionCmd);
              tmuxAvailable = true;
              tmuxVersion = stdout.trim();
            } catch { /* tmux not found on agent */ }
            return {
              status: 'online' as const,
              tmux: tmuxAvailable,
              tmuxVersion,
              agentVersion: health.version,
              hubVersion: hubBundleHash,
              versionMatch,
              message: tmuxAvailable ? undefined : 'tmux not found on agent server',
            };
          } catch (err: unknown) {
            return { status: 'offline' as const, tmux: false, message: `Agent unreachable: ${(err as Error).message}` };
          }
        } else {
          // Check if tmux is available locally
          let tmuxAvailable = false;
          let tmuxVersion = '';
          try {
            const { stdout } = await tmux.execCommand(srv, tmuxVersionCmd);
            tmuxAvailable = true;
            tmuxVersion = stdout.trim();
          } catch { /* tmux not found */ }
          return { status: 'online' as const, tmux: tmuxAvailable, tmuxVersion, message: tmuxAvailable ? undefined : 'tmux not found' };
        }
      } catch (err: unknown) {
        return { status: 'error' as const, tmux: false, message: (err as Error).message };
      }
    },
  );

  // ── GET /api/servers/:name/install-status ──
  fastify.get<{ Params: { name: string } }>(
    '/api/servers/:name/install-status',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const transport = transportFactory.getTransport(srv);

      const checkTmux = async () => {
        try {
          const cmd = srv.muxRuntime === 'managed'
            ? '$HOME/.azito/tmux/bin/tmux -L azito -f $HOME/.azito/tmux/azito.conf -V'
            : 'tmux -V';
          const r = await transport.exec(cmd);
          return { ...parseTmuxVersion(stripTerminalArtifacts(r.stdout), r.code), mode: srv.muxRuntime };
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message, mode: srv.muxRuntime };
        }
      };

      const checkNode = async () => {
        try {
          const r = await transport.exec('node --version');
          return parseNodeVersion(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkHarness = async () => {
        try {
          const r = await transport.exec('ls -d ~/.claude/skills/azt-* 2>/dev/null | head -1');
          return parseHarnessCheck(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkTailscale = async () => {
        try {
          const r = await transport.exec('tailscale ip -4');
          return parseTailscaleCheck(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkChromium = async (osName: string) => {
        try {
          const r = await transport.exec(findChromiumBinaryCommand(osName));
          return parseChromiumInstall(stripTerminalArtifacts(r.stdout));
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const checkAgent = async () => {
        try {
          const res = await fetch(`http://${srv.host}:${srv.agentPort}/health`, { signal: AbortSignal.timeout(5000) });
          if (!res.ok) return { installed: false, detail: `Agent returned ${res.status}` };
          const health = await res.json() as { version: string };
          // Bundle content hash comparison (see /status route); undefined when the
          // local bundle hasn't been built — matches the previous null-hubSha handling.
          const hubBundleHash = agentBundler ? agentBundler.getBundleHashIfBuilt() : null;
          const versionMatch = hubBundleHash ? health.version === hubBundleHash : undefined;
          return { installed: true, version: health.version, versionMatch };
        } catch (err: unknown) {
          return { installed: false, detail: (err as Error).message };
        }
      };

      const isRemote = srv.type === 'agent';
      const osName = (await transport.exec('uname -s')).stdout.trim();

      const [tmuxResult, nodeResult, harnessResult, tailscaleResult, agentResult, chromiumResult] = await Promise.all([
        checkTmux(),
        checkNode(),
        checkHarness(),
        isRemote ? checkTailscale() : null,
        srv.type === 'agent' ? checkAgent() : null,
        checkChromium(osName),
      ]);

      const result: Record<string, unknown> = {
        tmux: tmuxResult,
        node: nodeResult,
        aztHarness: harnessResult,
      };
      if (tailscaleResult) result.tailscale = tailscaleResult;
      if (agentResult) result.agent = agentResult;
      if (chromiumResult) result.chromium = chromiumResult;

      return result;
    },
  );

  // ── POST /api/servers/:name/install-tmux ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/install-tmux',
    async (request, reply) => {
      if (!tmuxInstaller) return reply.status(501).send({ error: 'Tmux installer not available' });
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      if (srv.muxRuntime !== 'managed') return reply.status(400).send({ error: 'Only managed mode supports tmux installation' });
      const transport = transportFactory.getTransport(srv);
      const result = await tmuxInstaller.install(transport);
      if (!result.success) return reply.status(500).send({ error: result.error });
      return { ok: true, version: result.version };
    },
  );

  // ── POST /api/servers/:name/install-browser-runtime ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/install-browser-runtime',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const transport = transportFactory.getTransport(srv);
      const { BrowserRuntimeInstaller } = await import('./agent-deploy/BrowserRuntimeInstaller.js');
      const installer = new BrowserRuntimeInstaller();
      const result = await installer.install(transport);
      if (!result.success) return reply.status(500).send({ error: result.error, warning: result.warning });
      return { ok: true, chromiumVersion: result.chromiumVersion, fontInstalled: result.fontInstalled, warning: result.warning };
    },
  );

  // ── POST /api/servers/:name/apply-tmux-config ──
  fastify.post<{ Params: { name: string } }>(
    '/api/servers/:name/apply-tmux-config',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      const transport = transportFactory.getTransport(srv);
      const { buildApplyTmuxConfigCommands } = await import('./agent-deploy/TmuxInstaller.js');
      const commands = buildApplyTmuxConfigCommands('$HOME');
      for (const cmd of commands) {
        await transport.exec(cmd);
      }
      return { ok: true, applied: true };
    },
  );

  // ── GET /api/servers/:name/branches ──
  fastify.get<{ Params: { name: string }; Querystring: { q?: string; project_id?: string; working_directory?: string } }>(
    '/api/servers/:name/branches',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const q = (request.query.q || '').trim().toLowerCase();
      const projectId = request.query.project_id ? parseInt(request.query.project_id, 10) : NaN;

      let workingDir: string | null | undefined = request.query.working_directory || undefined;
      if (!workingDir && !isNaN(projectId) && projectRepo && projectServerRepo) {
        const projectServer = projectServerRepo.find(projectId, request.params.name);
        workingDir = projectServer?.workingDirectory;
      }

      if (!workingDir) return { branches: [] };

      try {
        const safeDir = workingDir.replace(/'/g, "'\\''");
        const cmd = `cd '${safeDir}' && git branch -a --format='%(refname:short)' 2>/dev/null`;
        const result = await tmux.execCommand(srv, cmd);
        const lines = stripTerminalArtifacts(result.stdout).trim().split('\n').filter(Boolean);

        const seen = new Set<string>();
        const branches: string[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'HEAD' || trimmed.endsWith('/HEAD')) continue;
          const name = trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed;
          if (seen.has(name)) continue;
          seen.add(name);
          if (!q || name.toLowerCase().startsWith(q)) branches.push(name);
          if (branches.length >= 20) break;
        }

        return { branches };
      } catch {
        return { branches: [] };
      }
    },
  );

  // ── GET /api/servers/:name/editor-uri ──
  fastify.get<{ Params: { name: string }; Querystring: { path?: string; editor?: string } }>(
    '/api/servers/:name/editor-uri',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });

      const filePath = (request.query.path || '').trim();
      if (!filePath) return reply.status(400).send({ error: 'path query parameter required' });

      const editor = (request.query.editor || '').trim();
      if (!editor || !['vscode', 'zed'].includes(editor)) {
        return reply.status(400).send({ error: 'editor must be "vscode" or "zed"' });
      }

      // Resolve SSH host: for SSH servers use configured host, for local use Tailscale hostname
      let sshHost: string;
      if (srv.type === 'agent' && srv.host) {
        sshHost = srv.host.replace(/:.*$/, '');
      } else {
        const tsHost = await getTailscaleDnsName();
        try {
          if (!tsHost) throw new Error('tailscale DNS name unavailable');
          const user = execSync('whoami', { timeout: 2000 }).toString().trim();
          sshHost = `${user}@${tsHost}`;
        } catch {
          sshHost = `${process.env.USER || 'user'}@${os.hostname()}`;
        }
      }

      const pathMod = await import('path');
      const folderPath = pathMod.dirname(filePath);

      let uri: string;
      if (editor === 'vscode') {
        uri = `vscode://vscode-remote/ssh-remote+${sshHost}${folderPath}`;
      } else {
        uri = `zed://ssh/${sshHost}${folderPath}`;
      }

      return { uri };
    },
  );

  // ── GET /api/server-info/base-urls ──
  fastify.get('/api/server-info/base-urls', () => {
    const port = process.env.PORT || '3001';
    const candidates: { label: string; url: string }[] = [];

    const dnsName = getTailscaleDnsName();
    const tsIp = getTailscaleIp();

    if (dnsName) candidates.push({ label: 'Tailscale (DNS)', url: `http://${dnsName}:${port}` });
    if (tsIp) candidates.push({ label: 'Tailscale (IP)', url: `http://${tsIp}:${port}` });

    for (const ip of getLanIps()) {
      candidates.push({ label: `LAN (${ip})`, url: `http://${ip}:${port}` });
    }

    return { candidates };
  });

  // ── DELETE /api/servers/:name/ssh-fingerprint ──
  fastify.delete<{ Params: { name: string } }>(
    '/api/servers/:name/ssh-fingerprint',
    async (request, reply) => {
      const srv = serverRepo.findByName(request.params.name);
      if (!srv) return reply.status(404).send({ error: 'Server not found' });
      serverRepo.clearFingerprint(request.params.name);
      return { ok: true };
    },
  );

  done();
};

export default serversRoutes;
