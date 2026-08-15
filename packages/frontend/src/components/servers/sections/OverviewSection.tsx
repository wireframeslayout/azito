import { useTranslation } from 'react-i18next';
import type { Server, Session } from '../../../hooks/useServerManagement';
import type { IsolationReport } from '../../../hooks/useServerDetail';
import type { ServerStatus, InstallStatusResponse } from '../serverSections';
import { getHealthLevel, useServerResourcesContext } from '../../../hooks/useServerResources';
import type { HealthLevel } from '../../../hooks/useServerResources';
import { HealthDot, HEALTH_COLOR_VAR } from '../../statusbar/HealthDot';
import { ResourceMeter } from '../../statusbar/ResourceMeter';
import { healthReasonText, formatBytes } from '../../statusbar/ResourceDropdown';
import { Chip, Button, Notice } from '../../ui';

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
  refresh: () => void;
  onEdit: () => void;
}

export default function OverviewSection({ server, status, installStatus, sessions, isolationReport, isolationReportUnavailable, refresh, onEdit }: OverviewSectionProps) {
  const { t } = useTranslation('servers');
  // Issue #29 review, Important finding 2: a 'cleanup' report that did not
  // land on 'done' means a previously-distributed operator token may still
  // be sitting on this server despite it now being labeled isolated — the
  // approval UI elsewhere in the app already promises operators "no token is
  // injected", so this has to be surfaced somewhere an operator will
  // actually see it before trusting that promise. 'verification' reports
  // (the future isolation doctor) are intentionally not handled here yet.
  const isolationCleanupWarning = isolationReport?.kind === 'cleanup' && isolationReport.cleanup && isolationReport.cleanup !== 'done';
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
