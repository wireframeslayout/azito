import { useTranslation } from 'react-i18next';
import type { MisaoServiceState } from '@azito/shared';
import { Button, Chip, Notice, Spinner } from '../../ui';
import type { ChipTone } from '../../ui';
import { useConfirm } from '../../../hooks/useConfirm';
import { useMisaoService } from '../../../hooks/useMisaoService';
import { misaoNotices, misaoServiceMode, misaoVersions, unmanagedReasonKey, type MisaoNotice } from '../../../lib/misaoService';

const STATE_CHIP: Record<MisaoServiceState, { key: string; tone: ChipTone }> = {
  active: { key: 'stateActive', tone: 'green' },
  inactive: { key: 'stateInactive', tone: 'orange' },
  failed: { key: 'stateFailed', tone: 'red' },
  unknown: { key: 'stateUnknown', tone: 'default' },
};

const NOTICE_TONE: Record<MisaoNotice, 'warning' | 'info'> = {
  incompatible: 'warning',
  updateAvailable: 'warning',
  needsHubRestart: 'info',
  customSocket: 'warning',
};

const mutedStyle = { fontSize: 'var(--font-xs)', color: 'var(--text-dim)' } as const;

interface MisaoServicePanelProps {
  /** Runs after an install / start / update succeeded, so the rows that depend on the daemon are checked again. */
  onChanged: () => void;
}

/**
 * The misao service of the hub host: its state and versions, and the explicit actions (install, start, update). The
 * update stops the daemon and so closes every pane; it is only sent after the user confirmed it in the dialog.
 * Nothing here runs on its own — the hub never restarts the service by itself, not even on a hub update.
 */
export function MisaoServicePanel({ onChanged }: MisaoServicePanelProps) {
  const { t } = useTranslation('servers');
  const confirm = useConfirm();
  const misao = useMisaoService(onChanged);
  const { status, loading, loadFailed, busy, actionError } = misao;

  if (loading) {
    return (
      <div role="status" style={{ ...mutedStyle, display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <Spinner size={10} />
        {t('misaoService.loading')}
      </div>
    );
  }
  if (!status) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <span role="alert" style={{ ...mutedStyle, color: 'var(--danger)' }}>{loadFailed ? t('misaoService.loadFailed') : ''}</span>
        <Button size="sm" onClick={() => { void misao.refresh(); }}>{t('setup.retry')}</Button>
      </div>
    );
  }

  const mode = misaoServiceMode(status);
  const versions = misaoVersions(status);
  const notices = misaoNotices(status);

  const handleInstall = async (): Promise<void> => {
    if (status.socketSetting === 'custom') {
      const ok = await confirm({
        title: t('misaoService.replaceSocketTitle'),
        message: t('misaoService.replaceSocketMessage'),
        confirmLabel: t('misaoService.replaceSocketConfirm'),
      });
      if (!ok) return;
      await misao.install({ replaceSocketSetting: true });
      return;
    }
    await misao.install();
  };

  const handleUpdate = async (): Promise<void> => {
    const ok = await confirm({
      title: t('misaoService.updateConfirmTitle'),
      message: t('misaoService.updateConfirmMessage'),
      confirmLabel: t('misaoService.updateConfirmLabel'),
      danger: true,
    });
    if (ok) await misao.update();
  };

  if (mode === 'unmanaged') {
    return (
      <div style={mutedStyle}>
        {t(`misaoService.unmanaged.${unmanagedReasonKey(status.unmanagedReason)}`)}
        {status.unmanagedDetail && <span style={{ display: 'block', overflowWrap: 'anywhere' }}>{status.unmanagedDetail}</span>}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <span style={mutedStyle}>{t('misaoService.service')}</span>
        {status.serviceState
          ? <Chip tone={STATE_CHIP[status.serviceState].tone}>{t(`misaoService.${STATE_CHIP[status.serviceState].key}`)}</Chip>
          : <Chip tone="orange">{t('misaoService.stateNotInstalled')}</Chip>}
        {versions.bundled && <span style={{ ...mutedStyle, fontFamily: 'var(--mono)' }}>{t('misaoService.bundledVersion', { version: versions.bundled })}</span>}
        {versions.running && <span style={{ ...mutedStyle, fontFamily: 'var(--mono)' }}>{t('misaoService.runningVersion', { version: versions.running })}</span>}
      </div>

      {notices.map((notice) => (
        <Notice key={notice} tone={NOTICE_TONE[notice]} sub={t(`misaoService.notice.${notice}Sub`)}>
          {t(`misaoService.notice.${notice}`, { bundled: versions.bundled ?? '?', running: versions.running ?? '?' })}
        </Notice>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {mode === 'not_installed' && (
          <Button size="sm" variant="primary" loading={busy === 'install'} loadingLabel={t('misaoService.installing')} disabled={busy !== null} onClick={() => { void handleInstall(); }}>
            {t('misaoService.install')}
          </Button>
        )}
        {mode === 'stopped' && (
          <Button size="sm" variant="primary" loading={busy === 'start'} loadingLabel={t('misaoService.starting')} disabled={busy !== null} onClick={() => { void misao.start(); }}>
            {t('misaoService.start')}
          </Button>
        )}
        {mode !== 'not_installed' && status.updateAvailable && (
          <Button size="sm" variant="danger" loading={busy === 'update'} loadingLabel={t('misaoService.updating')} disabled={busy !== null} onClick={() => { void handleUpdate(); }}>
            {t('misaoService.update')}
          </Button>
        )}
      </div>

      {actionError && (
        <div role="alert" style={{ ...mutedStyle, color: 'var(--danger)', overflowWrap: 'anywhere' }}>{actionError}</div>
      )}
    </div>
  );
}
