import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chip } from '../ui/Chip';
import { Spinner } from '../ui/Spinner';
import { useSystemUpdate } from '../../hooks/useSystemUpdate';
import { useConfirm } from '../../hooks/useConfirm';
import ActivityDiagnosticsPanel from './sections/ActivityDiagnosticsPanel';
import type { DeployMode, SystemUpdateStatus, VersionEntry } from '../../hooks/useSystemUpdate';

const DEPLOY_MODE_LABEL: Record<DeployMode, string> = {
  systemd: 'systemd',
  launchd: 'launchd',
  source: 'source (dev)',
};

const STATUS_KEYS: Record<string, string> = {
  'up-to-date': 'system.statusUpToDate',
  'checking': 'system.statusChecking',
  'update-available': 'system.statusUpdateAvailable',
  'check-failed': 'system.statusCheckFailed',
  'confirming': 'system.statusConfirming',
  'running': 'system.statusRunning',
  'restarting': 'system.statusRestarting',
  'success': 'system.statusSuccess',
  'failed': 'system.statusFailed',
  'disabled': 'system.statusDisabled',
  'blocked': 'system.statusBlocked',
};

function statusTone(status: SystemUpdateStatus): 'green' | 'accent' | 'red' | 'default' {
  if (status === 'up-to-date' || status === 'success') return 'green';
  if (status === 'update-available') return 'accent';
  if (status === 'check-failed' || status === 'failed') return 'red';
  return 'default';
}

function shortSha(sha: string | null): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}

export default function SystemSection() {
  const { t } = useTranslation('settings');
  const {
    status,
    loading,
    checking,
    canStart,
    checkNow,
    startUpdate,
    channel,
    setChannel,
    versions,
    loadingVersions,
    fetchVersions,
    startUpdateToVersion,
  } = useSystemUpdate();
  const [startError, setStartError] = useState<string | null>(null);
  const confirm = useConfirm();

  const handleStartUpdate = async (): Promise<void> => {
    setStartError(null);
    const res = await startUpdate();
    if (!res.started) setStartError(res.error ?? t('system.couldNotStart'));
  };

  const canInstall = status?.deployMode !== 'source' && (status?.runningTasks ?? 0) === 0;

  const handleInstallVersion = async (v: VersionEntry): Promise<void> => {
    if (v.relation === 'older') {
      const ok = await confirm({
        title: t('system.rollbackConfirmTitle'),
        message: t('system.rollbackConfirmMessage'),
        confirmLabel: t('system.rollbackConfirmLabel'),
        danger: true,
      });
      if (!ok) return;
    }
    setStartError(null);
    const res = await startUpdateToVersion(v.version);
    if (!res.started) setStartError(res.error ?? t('system.couldNotStart'));
  };

  // 稼働検知診断の表示資格はサーバーが判定する（ソースコード版、またはインストール版で
  // 開発中バージョンチャンネル）。判定結果はこの更新情報応答に載るため、応答が取れていない
  // 間は節ごと出さない（一般利用者の画面に診断を出さない側に倒す）。
  const showDiagnostics = status?.diagnosticsEnabled === true;

  if (loading && !status) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>Loading...</div>
    );
  }

  if (!status) {
    return (
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
        {t('system.fetchFailed')}
      </p>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 20, lineHeight: 1.5 }}>
        {t('system.description')}
      </p>

      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20 }}>
        <SectionRow label={t('system.deployMode')}>
          <Chip>{DEPLOY_MODE_LABEL[status.deployMode]}</Chip>
        </SectionRow>
        <SectionRow label={t('system.repository')}>
          <span style={{ fontSize: 'var(--font-md)', fontFamily: 'var(--mono)', color: 'var(--text)' }}>{status.repo ?? '—'}</span>
        </SectionRow>
        <SectionRow label={t('system.currentVersion')}>
          <span style={{ fontSize: 'var(--font-md)', fontFamily: 'var(--mono)', color: 'var(--text)' }}>
            {status.currentVersion ?? '—'} <span style={{ color: 'var(--text-dim)' }}>({shortSha(status.currentCommit)})</span>
          </span>
        </SectionRow>
        <SectionRow label={t('system.status')}>
          <Chip tone={statusTone(status.status)}>{STATUS_KEYS[status.status] ? t(STATUS_KEYS[status.status]) : status.status}</Chip>
        </SectionRow>
        {status.deployMode !== 'source' && (
          <SectionRow label={t('system.devChannel')}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={channel === 'rc'}
                onChange={(e) => {
                  const next = e.target.checked ? 'rc' as const : 'stable' as const;
                  void (async () => {
                    try { await setChannel(next); } catch { setStartError(t('system.channelSwitchFailed')); }
                  })();
                }}
              />
              <span className="toggle-slider" />
            </label>
          </SectionRow>
        )}

        {channel === 'rc' && (
          <div style={{
            marginTop: 12, padding: '8px 10px', borderRadius: 'var(--radius-sm)',
            background: 'var(--warning-a08)', border: '1px solid var(--warning-a35)',
            color: 'var(--warning)', fontSize: 'var(--font-md)',
          }}>
            {t('system.devChannelWarning')}
          </div>
        )}

        {channel === 'rc' && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 'var(--font-md)', fontWeight: 500, color: 'var(--text)' }}>{t('system.availableVersions')}</span>
              <button className="btn btn-sm" onClick={() => { void fetchVersions(); }} disabled={loadingVersions} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {loadingVersions && <Spinner size={10} />}
                {t('system.refreshVersions')}
              </button>
            </div>
            {loadingVersions && versions.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>
                <Spinner size={14} />
              </div>
            ) : versions.length === 0 ? (
              <div style={{ padding: '8px 0', color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>
                {t('system.noVersionsFound')}
              </div>
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                {versions.map((v, i) => (
                  <VersionRow
                    key={v.version}
                    entry={v}
                    isCurrent={v.relation === 'same'}
                    hasBorder={i < versions.length - 1}
                    onInstall={() => { void handleInstallVersion(v); }}
                    disabled={v.relation === 'same' || !canInstall}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {status.status === 'disabled' && status.disabledReason && (
          <div style={{
            marginTop: 12, padding: '8px 10px', borderRadius: 'var(--radius-sm)',
            background: 'var(--bg)', border: '1px solid var(--border)',
            color: 'var(--text-dim)', fontSize: 'var(--font-sm)',
          }}>
            {status.disabledReason}
          </div>
        )}

        {status.status === 'check-failed' && (
          <div style={{
            marginTop: 12, padding: '8px 10px', borderRadius: 'var(--radius-sm)',
            background: 'var(--danger-a08)', border: '1px solid var(--danger-a35)',
            color: 'var(--danger)', fontSize: 'var(--font-sm)',
          }}>
            {t('system.checkFailedDetail')}
          </div>
        )}

        {status.runningTasks > 0 && (
          <div style={{
            marginTop: 12,
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--warning-a08)',
            border: '1px solid var(--warning-a35)',
            color: 'var(--warning)',
            fontSize: 'var(--font-md)',
          }}>
            {t('system.runningTasksWarning', { count: status.runningTasks })}
          </div>
        )}

        {startError && (
          <div role="alert" style={{
            marginTop: 12,
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--danger-a08)',
            border: '1px solid var(--danger-a35)',
            color: 'var(--danger)',
            fontSize: 'var(--font-md)',
          }}>
            {startError}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => { void handleStartUpdate(); }}
            disabled={!canStart}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {t('system.updateAndRestart')}
          </button>
          <button
            className="btn btn-sm"
            onClick={checkNow}
            disabled={checking}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {checking && <Spinner size={10} />}
            {t('system.checkForUpdates')}
          </button>
        </div>
      </div>

      {showDiagnostics && <ActivityDiagnosticsPanel />}
    </div>
  );
}

function VersionRow({ entry, isCurrent, hasBorder, onInstall, disabled }: {
  entry: VersionEntry;
  isCurrent: boolean;
  hasBorder: boolean;
  onInstall: () => void;
  disabled: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 12px',
      borderBottom: hasBorder ? '1px solid var(--border)' : 'none',
      background: isCurrent ? 'var(--accent-a08)' : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 'var(--font-md)', fontFamily: 'var(--mono)', color: 'var(--text)' }}>{entry.version}</span>
        {entry.prerelease && <Chip tone="purple">rc</Chip>}
        {isCurrent && <Chip tone="green">{t('system.current')}</Chip>}
        <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginLeft: 'auto', flexShrink: 0 }}>
          {new Date(entry.publishedAt).toLocaleDateString('ja-JP')}
        </span>
      </div>
      <button
        className="btn btn-sm"
        onClick={onInstall}
        disabled={disabled}
        style={{ marginLeft: 12, flexShrink: 0 }}
      >
        {t('system.install')}
      </button>
    </div>
  );
}

function SectionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', borderBottom: '1px solid var(--border)',
    }}>
      <span style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)' }}>{label}</span>
      {children}
    </div>
  );
}
