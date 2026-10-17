import { useTranslation } from 'react-i18next';
import { Button, Notice, Spinner } from '../../ui';
import type { AgentMisaoInstallState } from '../../../hooks/useAgentMisaoInstall';
import type { InstallStatusItem } from '../serverSections';

const mutedStyle = { fontSize: 'var(--font-xs)', color: 'var(--text-dim)' } as const;

const KNOWN_STEPS = ['inspect', 'transfer', 'prepare', 'start'] as const;

interface AgentMisaoPanelProps {
  /** The misao row of the server's install status. */
  item: InstallStatusItem;
  /** How the install is going (see useAgentMisaoInstall). */
  state: AgentMisaoInstallState;
  onInstall: () => void;
}

/**
 * The misao of an agent server: installing it from the hub's bundled copy (sent through the agent, nothing is downloaded
 * on the server), how far the install is, and why it failed. A daemon of another release than the bundled one is only
 * pointed out: switching it ends every pane, so it is never done on its own.
 */
export function AgentMisaoPanel({ item, state, onInstall }: AgentMisaoPanelProps) {
  const { t } = useTranslation('servers');
  const { installing, step, error } = state;
  const stepLabel = step && (KNOWN_STEPS as readonly string[]).includes(step) ? t(`agentMisao.step.${step}`) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 }}>
      {item.installed && item.updateAvailable && (
        <Notice tone="warning" sub={t('agentMisao.updateAvailableSub')}>
          {t('agentMisao.updateAvailable', { running: item.daemonVersion ?? '?', bundled: item.bundledVersion ?? '?' })}
        </Notice>
      )}

      {!item.installed && item.installable === false && (
        <div style={mutedStyle}>{t('agentMisao.notInstallable')}</div>
      )}

      {!item.installed && item.installable !== false && (
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
          {stepLabel ?? t('agentMisao.installing')}
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...mutedStyle, color: 'var(--danger)', overflowWrap: 'anywhere' }}>
          {t('agentMisao.failed')}: {error}
        </div>
      )}
    </div>
  );
}
