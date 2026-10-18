import { useTranslation } from 'react-i18next';
import { useConfirm } from '../../../hooks/useConfirm';
import { Button, Notice, Spinner } from '../../ui';
import type { AgentMisaoInstallState } from '../../../hooks/useAgentMisaoInstall';
import type { InstallStatusItem } from '../serverSections';

const mutedStyle = { fontSize: 'var(--font-xs)', color: 'var(--text-dim)' } as const;

const KNOWN_STEPS = ['inspect', 'transfer', 'prepare', 'stop', 'start'] as const;

interface AgentMisaoPanelProps {
  /** The misao row of the server's install status. */
  item: InstallStatusItem;
  /** How the install is going (see useAgentMisaoInstall). */
  state: AgentMisaoInstallState;
  onInstall: () => void;
  /** Switches the running release to the bundled one. The panel asks for confirmation first: it ends every pane of the server. */
  onUpdate: () => void;
}

/**
 * The misao of an agent server: installing it from the hub's bundled copy (sent through the agent, nothing is downloaded
 * on the server), how far the install is, and why it failed. A daemon of another release than the bundled one is pointed
 * out, with an explicit update button: switching it ends every pane, so it is never done on its own and only after the
 * user confirmed it in the dialog.
 */
export function AgentMisaoPanel({ item, state, onInstall, onUpdate }: AgentMisaoPanelProps) {
  const { t } = useTranslation('servers');
  const confirm = useConfirm();
  const { installing, action, step, error } = state;
  const stepLabel = step && (KNOWN_STEPS as readonly string[]).includes(step) ? t(`agentMisao.step.${step}`) : null;

  const handleUpdate = async (): Promise<void> => {
    const ok = await confirm({
      title: t('agentMisao.updateConfirmTitle'),
      message: t('agentMisao.updateConfirmMessage'),
      confirmLabel: t('agentMisao.updateConfirmLabel'),
      danger: true,
    });
    if (ok) onUpdate();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 }}>
      {item.updateAvailable && (
        <Notice tone="warning" sub={t('agentMisao.updateAvailableSub')}>
          {t('agentMisao.updateAvailable', { running: item.daemonVersion ?? '?', bundled: item.bundledVersion ?? '?' })}
        </Notice>
      )}

      {item.updateAvailable && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="danger"
            loading={installing && action === 'update'}
            loadingLabel={t('agentMisao.updating')}
            disabled={installing}
            onClick={() => { void handleUpdate(); }}
          >
            {error ? t('agentMisao.retry') : t('agentMisao.update')}
          </Button>
          <span style={mutedStyle}>{t('agentMisao.updateDesc')}</span>
        </div>
      )}

      {!item.installed && item.installable === false && (
        <div style={mutedStyle}>{t('agentMisao.notInstallable')}</div>
      )}

      {!item.installed && !item.updateAvailable && item.installable !== false && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <Button size="sm" variant="primary" loading={installing} loadingLabel={t('agentMisao.installing')} disabled={installing} onClick={onInstall}>
            {error ? t('agentMisao.retry') : t('agentMisao.install')}
          </Button>
          <span style={mutedStyle}>{t('agentMisao.installDesc')}</span>
        </div>
      )}

      {installing && (
        <div role="status" aria-live="polite" style={{ ...mutedStyle, display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Spinner size={10} />
          {stepLabel ?? t(action === 'update' ? 'agentMisao.updating' : 'agentMisao.installing')}
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...mutedStyle, color: 'var(--danger)', overflowWrap: 'anywhere' }}>
          {t(action === 'update' || item.updateAvailable ? 'agentMisao.updateFailed' : 'agentMisao.failed')}: {error}
        </div>
      )}
    </div>
  );
}
