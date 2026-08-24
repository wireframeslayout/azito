import { useTranslation } from 'react-i18next';
import type { Server, Session } from '../../../hooks/useServerManagement';
import type { IsolationReport } from '../../../hooks/useServerDetail';
import type { ServerStatus, InstallStatusResponse } from '../serverSections';
import { getHealthLevel, useServerResourcesContext } from '../../../hooks/useServerResources';
import type { HealthLevel } from '../../../hooks/useServerResources';
import { useIsolationDoctor } from '../../../hooks/useIsolationDoctor';
import { useHealth } from '../../../hooks/useHealth';
import { computeIsolationDoctorState, isValidVerificationReport } from './isolationDoctorState';
import { HealthDot, HEALTH_COLOR_VAR } from '../../statusbar/HealthDot';
import { ResourceMeter } from '../../statusbar/ResourceMeter';
import { healthReasonText, formatBytes } from '../../statusbar/ResourceDropdown';
import { Chip, Button, Notice, DocsLink } from '../../ui';

// Issue #29 Step 2 C: display-side TTL for the isolation doctor's last
// verification — purely advisory ("要再検証"), not a policy re-evaluation.
// Execute-time re-verification against this TTL is explicitly Step 3 scope
// (see the mission brief's "スコープ外" section); this constant only decides
// what the Overview page LABELS a stale verification as.
const ISOLATION_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

interface OverviewSectionProps {
  server: Server;
  status: ServerStatus | null;
  installStatus: InstallStatusResponse | null;
  sessions: Session[];
  isolationReport: IsolationReport | null;
  // Issue #29 review, Important finding 3: true when this server declares
  // isolationIntent but the detail fetch that would carry isolationReport
  // failed or came back malformed — see useServerDetail's doc comment. Must
  // not be treated the same as "no report" (isolationReport === null),
  // which silently reads as "nothing to warn about".
  isolationReportUnavailable: boolean;
  // Review round (Important finding 4): the cleanup-only counterpart to
  // isolationReport/isolationReportUnavailable above — the server now
  // persists the cleanup outcome and the doctor's verification outcome in
  // separate columns/fields (see useServerDetail's IsolationReport doc
  // comment), so both notices below can be computed and shown independently
  // instead of one clobbering the other.
  isolationCleanupReport: IsolationReport | null;
  isolationCleanupReportUnavailable: boolean;
  refresh: () => void;
  onEdit: () => void;
}

export default function OverviewSection({
  server, status, installStatus, sessions,
  isolationReport, isolationReportUnavailable,
  isolationCleanupReport, isolationCleanupReportUnavailable,
  refresh, onEdit,
}: OverviewSectionProps) {
  const { t } = useTranslation('servers');
  // Issue #29 review, Important finding 2: a 'cleanup' report that did not
  // land on 'done' means a previously-distributed operator token may still
  // be sitting on this server despite it now being labeled isolated — the
  // approval UI elsewhere in the app already promises operators "no token is
  // injected", so this has to be surfaced somewhere an operator will
  // actually see it before trusting that promise.
  //
  // Issue #29 review (final pass), Important finding 2: also fires for
  // `isolationCleanupReport === null` on a server that DOES declare
  // isolation — previously read as "nothing to warn about"
  // (indistinguishable from "no report ever needed"), but a
  // declared-isolated server with no report at all is exactly as unconfirmed
  // as an explicit 'pending'/'failed' one (either this is a pre-fix row from
  // before `updateIsolationIntent` started writing the pending marker
  // atomically, or something cleared the report without settling it). This
  // is independent of, and can show alongside, `isolationCleanupReportUnavailable`
  // below (a fetch failure also leaves `isolationCleanupReport` at `null`) —
  // both represent real uncertainty about whether the isolation promise
  // actually holds.
  //
  // Review round (Important finding 4): reads the dedicated
  // isolationCleanupReport field directly — no `kind` filter needed anymore,
  // since the column split means this field only ever carries a cleanup
  // outcome (a verification report can never land here).
  const isolationCleanupWarning = server.isolationIntent && (
    isolationCleanupReport === null ||
    isolationCleanupReport.cleanup !== 'done'
  );

  // Issue #29 Step 2 C: the doctor's verification report is a DISTINCT
  // signal from the cleanup outcome above — a server can show
  // isolationCleanupWarning === false (cleanup reported "done") while never
  // having been verified at all, or vice versa (cleanup failed, but an
  // earlier doctor run once passed). Both can be shown together; neither
  // suppresses the other.
  //
  // Follow-up review round, Minor finding 4: `isolationReport` is typed as
  // the shared `IsolationReport` union (kind: 'cleanup' | 'verification') —
  // this section must not assume, just because it arrived on the
  // `isolationReport` field, that it actually IS a verification report. A
  // cleanup-shaped report reaching here (a stale/pre-split row, a future
  // server-side regression that writes the wrong field) has no `verified`
  // boolean, so the old `verificationReport.verified === false` check was
  // always false for it and fell straight through to the "verified" render
  // — a false success reading. `computeIsolationDoctorState`
  // (isolationDoctorState.ts, unit-tested there) gates every field it reads
  // on the discriminant matching AND the shape it implies actually being
  // present, exactly like `isValidIsolationReport` (useServerDetail.ts)
  // already requires for the report as a WHOLE — this is defense in depth
  // for this render path specifically, not a replacement for that validator.
  const verificationReport = isolationReport;
  // Issue #29 review (5th pass), Important finding 1: mirrors the backend's
  // own C-1 gate (routes.ts's POST .../isolation/doctor now returns 409
  // isolation_doctor_requires_scoped_auth while scopedAuthEnabled is false)
  // — a stale "verified" report persisted from before compat mode (or from
  // before scoped auth was ever turned on) must not keep rendering as proof
  // of anything. See computeIsolationDoctorState's own doc comment for the
  // null-treated-as-"not confirmed off" rationale.
  const { scopedAuthEnabled } = useHealth();
  const isolationDoctorState = computeIsolationDoctorState({
    isolationIntent: !!server.isolationIntent,
    verificationReport,
    isolationVerifiedAt: server.isolationVerifiedAt,
    ttlMs: ISOLATION_VERIFICATION_TTL_MS,
    scopedAuthEnabled,
  });
  const failedOrUnknownChecks = (isValidVerificationReport(verificationReport) ? (verificationReport.checks ?? []) : []).filter((c) => c.status !== 'pass');
  const { running: isolationDoctorRunning, runDoctor } = useIsolationDoctor(server.type === 'agent' ? server.name : null, refresh);

  const resourceEntries = useServerResourcesContext();
  const resourceEntry = resourceEntries.find((s) => s.serverName === server.name);
  const resourcesLoading = resourceEntry === undefined;
  const measurement = resourceEntry?.measurement ?? null;

  const isAgent = server.type === 'agent';
  const isChecking = !status || status.status === 'checking';
  const isOnline = status?.status === 'online';
  const memUsedPercent = measurement ? 100 - measurement.memAvailablePercent : null;

  let heroTone: HealthLevel | 'unknown' = 'unknown';
  let heroTitle = t('status.checking');
  if (!isChecking) {
    if (isOnline) {
      if (resourcesLoading) {
        heroTone = 'unknown';
        heroTitle = t('overview.onlineMeasuring');
      } else if (measurement === null) {
        heroTone = 'unknown';
        heroTitle = t('overview.onlineNoMeasurement');
      } else {
        heroTone = getHealthLevel(measurement);
        heroTitle = heroTone === 'healthy' ? t('overview.onlineHealthy') : t('overview.onlineWithReason', { reason: healthReasonText(heroTone, memUsedPercent, t) });
      }
    } else {
      heroTone = 'critical';
      heroTitle = t('overview.cannotConnect');
    }
  }
  const heroColorVar = heroTone === 'unknown' ? 'var(--text-dim)' : HEALTH_COLOR_VAR[heroTone];

  const sessionCount = sessions.length;
  const windowCount = sessions.reduce((sum, s) => sum + s.windowCount, 0);
  const sessionsSummary = t('overview.sessionsSummary', { sessionCount, windowCount });

  const memUsedBytes = measurement ? measurement.memTotalBytes - measurement.memAvailableBytes : null;
  const cpuPercent = measurement ? Math.min(100, measurement.loadPerCore * 100) : null;
  const diskPercent = measurement?.diskUsedPercent ?? null;

  return (
    <div>
      <style>{`
        @keyframes azt-gauge-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
        .azt-gauge-skeleton { animation: azt-gauge-pulse 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .azt-gauge-skeleton { animation: none; opacity: 0.7; }
        }
      `}</style>
      <SectionHeading>{t('overview.title')}</SectionHeading>

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        background: 'var(--bg-card)',
        border: `1px solid color-mix(in srgb, ${heroColorVar} 30%, var(--border))`,
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              borderRadius: '50%',
              flexShrink: 0,
              boxShadow: heroTone === 'unknown'
                ? 'none'
                : `0 0 0 4px color-mix(in srgb, ${heroColorVar} 18%, transparent), 0 0 14px 2px color-mix(in srgb, ${heroColorVar} 55%, transparent)`,
            }}
          >
            {heroTone === 'unknown'
              ? <span style={{ display: 'inline-block', width: 14, height: 14, borderRadius: '50%', background: 'var(--text-dim)' }} />
              : <HealthDot level={heroTone} size={14} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-lg)', fontWeight: 700, color: heroColorVar }}>
              {heroTitle}
            </div>
            {(status?.message || isAgent) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
                {isAgent && (
                  <>
                    <span style={{ fontFamily: 'var(--mono)' }}>
                      agent {(server.agentVersion ?? '').slice(0, 7) || '—'}
                    </span>
                    {status?.versionMatch === true && <Chip tone="green">{t('overview.hubMatch')}</Chip>}
                    {status?.versionMatch === false && <Chip tone="orange">{t('overview.outdated')}</Chip>}
                  </>
                )}
                {status?.message && <span>{isAgent ? `(${status.message})` : status.message}</span>}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
          <Button size="sm" onClick={refresh}>{t('overview.reconnect')}</Button>
          {server.type !== 'local' && <Button size="sm" onClick={onEdit}>{t('overview.edit')}</Button>}
        </div>
      </div>

      {isolationCleanupWarning && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Notice tone="warning" sub={t('overview.isolationCleanupWarningSub')}>
            {t('overview.isolationCleanupWarningTitle')}
          </Notice>
        </div>
      )}

      {/* Issue #29 review, Important finding 3: distinct from
          isolationCleanupWarning above — that one means "we checked, and
          cleanup didn't fully succeed"; this one means "we couldn't check at
          all" (fetch failed / malformed body). Both are real uncertainty an
          operator relying on the isolation promise needs to see, so this
          never suppresses or replaces the cleanup warning — they can show
          together if a stale report existed before this fetch failed. */}
      {isolationReportUnavailable && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Notice tone="warning" sub={t('overview.isolationReportUnavailableSub')}>
            {t('overview.isolationReportUnavailableTitle')}
          </Notice>
        </div>
      )}

      {/* Review round (Important finding 4): the cleanup-field counterpart
          to isolationReportUnavailable above — independently unavailable
          since the two outcomes now live in separate response fields (see
          useServerDetail's IsolationReport doc comment). Can show alongside
          isolationReportUnavailable, isolationCleanupWarning, or neither. */}
      {isolationCleanupReportUnavailable && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Notice tone="warning" sub={t('overview.isolationCleanupReportUnavailableSub')}>
            {t('overview.isolationCleanupReportUnavailableTitle')}
          </Notice>
        </div>
      )}

      {/* Issue #29 Step 2 C: the isolation doctor's own state — independent
          of the cleanup warning above (see isolationDoctorState's doc
          comment). Only rendered for an agent-type server that currently
          declares isolation; the run button only appears here too (running
          the doctor on a non-isolated or non-agent server is rejected
          server-side with 400). */}
      {isolationDoctorState !== null && server.type === 'agent' && (
        <div style={{ marginBottom: 'var(--space-4)' }}>
          <Notice
            tone={isolationDoctorState === 'verified' ? 'success' : isolationDoctorState === 'needsAttention' || isolationDoctorState === 'scopedAuthDisabled' ? 'danger' : 'warning'}
            sub={
              <>
                {t('overview.isolationPurposeSub')}
                {' '}
                {isolationDoctorState === 'scopedAuthDisabled'
                  ? t('overview.isolationDoctorScopedAuthDisabledSub')
                  : isolationDoctorState === 'scopedAuthUnknown'
                    ? t('overview.isolationDoctorScopedAuthUnknownSub')
                    : isolationDoctorState === 'needsAttention'
                      ? t('overview.isolationDoctorNeedsAttentionSub', {
                          checks: failedOrUnknownChecks.map((c) => `${c.id} (${c.status})`).join(', '),
                        })
                      : t('overview.isolationDoctorSnapshotNotice')}
                {' '}
                {/* Issue #29 docs linking: shown once per isolation-doctor
                    Notice (not per Notice above it) — this is the block
                    operators reach for when they need to actually understand
                    isolation, not the transient cleanup/fetch-failure
                    warnings, so a single link here is enough. */}
                <DocsLink page="isolated-execution" />
              </>
            }
            action={
              // Issue #29 review (5th pass), Important finding 1: the run
              // button is disabled while scoped auth is confirmed off — the
              // backend would reject the request with 409 anyway, and
              // letting an operator retry a call that can never succeed
              // while compat mode is on is worse than telling them upfront.
              //
              // Final review round, Important finding 2: also disabled while
              // scoped auth is UNCONFIRMED (scopedAuthUnknown) — a health
              // check that hasn't resolved gives no basis to know whether the
              // backend would even accept the run, so the button stays
              // disabled until that's confirmed one way or the other, same as
              // the confirmed-off case above.
              <Button
                size="sm"
                onClick={runDoctor}
                loading={isolationDoctorRunning}
                loadingLabel={t('overview.isolationDoctorRunning')}
                disabled={isolationDoctorState === 'scopedAuthDisabled' || isolationDoctorState === 'scopedAuthUnknown'}
              >
                {t('overview.isolationDoctorRun')}
              </Button>
            }
          >
            {isolationDoctorState === 'scopedAuthDisabled'
              ? t('overview.isolationDoctorScopedAuthDisabled')
              : isolationDoctorState === 'scopedAuthUnknown'
                ? t('overview.isolationDoctorScopedAuthUnknown')
                : isolationDoctorState === 'verified' && server.isolationVerifiedAt
                  ? t('overview.isolationDoctorVerified', { at: new Date(server.isolationVerifiedAt).toLocaleString() })
                  : isolationDoctorState === 'verifiedStale' && server.isolationVerifiedAt
                    ? t('overview.isolationDoctorVerifiedStale', { at: new Date(server.isolationVerifiedAt).toLocaleString() })
                    : isolationDoctorState === 'needsAttention'
                      ? t('overview.isolationDoctorNeedsAttention')
                      : t('overview.isolationDoctorUnverified')}
          </Notice>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 'var(--space-3)',
        marginBottom: 'var(--space-4)',
      }}>
        <GaugeTile
          label="MEM"
          loading={resourcesLoading}
          value={memUsedPercent}
          warning={memUsedPercent !== null && memUsedPercent >= 60}
          detail={measurement ? `${formatBytes(memUsedBytes ?? 0)} / ${formatBytes(measurement.memTotalBytes)}` : t('overview.notMeasurable')}
          measuringLabel={t('overview.measuring')}
        />
        <GaugeTile
          label="CPU"
          loading={resourcesLoading}
          value={cpuPercent}
          warning={measurement !== null && measurement.loadPerCore > 1.5}
          detail={measurement ? `load ${measurement.loadPerCore.toFixed(2)}/core` : t('overview.notMeasurable')}
          measuringLabel={t('overview.measuring')}
        />
        <GaugeTile
          label="DISK"
          loading={resourcesLoading}
          value={diskPercent}
          warning={diskPercent !== null && diskPercent > 80}
          detail={measurement && measurement.diskUsedBytes !== null && measurement.diskTotalBytes !== null
            ? `${formatBytes(measurement.diskUsedBytes)} / ${formatBytes(measurement.diskTotalBytes)}`
            : t('overview.notMeasurable')}
          measuringLabel={t('overview.measuring')}
        />
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
        gap: 'var(--space-3)',
      }}>
        <KvCard title={t('overview.connectionTitle')}>
          <KvRow label={t('overview.typeLabel')}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)' }}>{server.type}</span>
          </KvRow>
          {(server.host || isAgent) && (
            <KvRow label={t('overview.hostLabel')}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)' }}>
                {server.host}{isAgent && server.agentPort ? `:${server.agentPort}` : ''}
              </span>
            </KvRow>
          )}
          {server.sshHost && (
            <KvRow label={t('overview.sshBootstrap')}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)' }}>{server.sshHost}</span>
            </KvRow>
          )}
          {isAgent && (
            <KvRow label={t('overview.authToken')}>
              <span style={{ fontSize: 'var(--font-xs)' }}>
                {server.hasAgentToken ? t('overview.tokenSet') : t('overview.tokenNotSet')}
              </span>
            </KvRow>
          )}
          {isAgent && (
            <KvRow label={t('overview.isolationLabel')}>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{
                  fontSize: 'var(--font-xs)',
                  color: !server.isolationIntent
                    ? 'var(--text-dim)'
                    : isolationDoctorState === 'verified'
                      ? 'var(--success)'
                      : isolationDoctorState === 'needsAttention' || isolationDoctorState === 'scopedAuthDisabled'
                        ? 'var(--danger)'
                        : 'var(--warning)',
                }}>
                  {!server.isolationIntent
                    ? t('overview.isolationDisabledValue')
                    : isolationDoctorState === 'verified'
                      ? t('overview.isolationEnabledVerified')
                      : isolationDoctorState === 'verifiedStale'
                        ? t('overview.isolationEnabledVerifiedStale')
                        : isolationDoctorState === 'needsAttention'
                          ? t('overview.isolationEnabledNeedsAttention')
                          : isolationDoctorState === 'scopedAuthDisabled'
                            ? t('overview.isolationEnabledScopedAuthDisabled')
                            : isolationDoctorState === 'scopedAuthUnknown'
                              ? t('overview.isolationEnabledScopedAuthUnknown')
                              : t('overview.isolationEnabledUnverified')}
                </span>
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
                  {server.isolationIntent ? t('overview.isolationEnabledHint') : t('overview.isolationDisabledHint')}
                </span>
              </span>
            </KvRow>
          )}
        </KvCard>

        <KvCard title={t('overview.runtimeTitle')}>
          <KvRow label={t('overview.muxRuntimeLabel')}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)' }}>
              {server.muxRuntime === 'managed' ? t('overview.muxManaged') : `${t('overview.muxSystem')}${status?.tmuxVersion ? ` ${status.tmuxVersion}` : ''}`}
            </span>
          </KvRow>
          {isAgent && (
            <KvRow label={t('overview.agentVersionLabel')}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)' }}>
                {(server.agentVersion ?? '').slice(0, 7) || '—'}
              </span>
            </KvRow>
          )}
          <KvRow label={t('overview.browserSupport')}>
            <span style={{
              fontSize: 'var(--font-xs)',
              color: installStatus?.chromium
                ? (installStatus.chromium.installed ? 'var(--success)' : 'var(--text-dim)')
                : 'var(--text-dim)',
            }}>
              {!installStatus?.chromium
                ? t('status.checking')
                : installStatus.chromium.installed
                  ? `${t('overview.supported')}${installStatus.chromium.version ? ` (${installStatus.chromium.version})` : ''}`
                  : t('overview.notSupported')}
            </span>
          </KvRow>
          <KvRow label={t('overview.sessionsLabel')}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)' }}>{sessionsSummary}</span>
          </KvRow>
        </KvCard>
      </div>
    </div>
  );
}

function GaugeTile({ label, value, detail, warning, loading, measuringLabel }: {
  label: string;
  value: number | null;
  detail: string;
  warning: boolean;
  loading: boolean;
  measuringLabel: string;
}) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-3)',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 0,
    }}>
      <span style={{
        fontFamily: 'var(--mono)',
        fontSize: 'var(--font-xs)',
        letterSpacing: '.1em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
      }}>
        {label}
      </span>
      {loading ? (
        <>
          <span className="azt-gauge-skeleton" style={{
            display: 'inline-block', width: 40, height: 18, borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--border) 70%, transparent)',
          }} />
          <span className="azt-gauge-skeleton" style={{
            display: 'block', width: '100%', height: 6, borderRadius: 'var(--radius-sm)',
            background: 'color-mix(in srgb, var(--border) 60%, transparent)',
          }} />
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{measuringLabel}</span>
        </>
      ) : (
        <>
          <span style={{
            fontFamily: 'var(--mono)',
            fontSize: 'var(--font-lg)',
            fontWeight: 700,
            color: value === null ? 'var(--text-dim)' : warning ? 'var(--warning)' : 'var(--text)',
          }}>
            {value === null ? '—' : `${Math.round(value)}%`}
          </span>
          <ResourceMeter value={value ?? 0} width="100%" warning={warning} />
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{detail}</span>
        </>
      )}
    </div>
  );
}

function KvCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
    }}>
      <div style={{
        fontFamily: 'var(--mono)',
        fontSize: 'var(--font-xs)',
        letterSpacing: '.1em',
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
        marginBottom: 'var(--space-3)',
      }}>
        {title}
      </div>
      <dl style={{
        display: 'grid',
        gridTemplateColumns: '130px 1fr',
        rowGap: 8,
        columnGap: 12,
        margin: 0,
        fontSize: 'var(--font-sm)',
      }}>
        {children}
      </dl>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontFamily: 'var(--mono)',
      fontSize: 'var(--font-xs)',
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      color: 'var(--text-dim)',
      borderBottom: '1px solid var(--border)',
      paddingBottom: 6,
      marginBottom: 12,
      marginTop: 0,
    }}>
      {children}
    </h3>
  );
}

function KvRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt style={{ color: 'var(--text-dim)', margin: 0 }}>{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </>
  );
}
