import { useTranslation } from 'react-i18next';
import { Button, Chip, DocsLink, Notice, ToggleField } from '../../ui';
import type { ChipTone } from '../../ui';
import type { ServerDeletion } from '../../../hooks/useServerDeletion';
import type { UninstallOutcome, UninstallStep } from '../../../lib/serverDeletion';

const OUTCOME_TONE: Record<UninstallOutcome, ChipTone> = { done: 'green', absent: 'default', failed: 'red', skipped: 'orange' };

interface DeleteServerPanelProps {
  deletion: ServerDeletion;
}

/** The result of each step on the host, failures first in meaning (the chip says it, the reason is under the step). */
function StepList({ steps }: { steps: readonly UninstallStep[] }) {
  const { t } = useTranslation('servers');
  return (
    <ul aria-label={t('danger.hostRemoval.stepsLabel')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {steps.map((step) => (
        <li key={step.id} style={{ fontSize: 'var(--font-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text)' }}>{t(`danger.hostRemoval.steps.${step.id}`)}</span>
            <Chip tone={OUTCOME_TONE[step.outcome]}>{t(`danger.hostRemoval.outcomes.${step.outcome}`)}</Chip>
          </div>
          {step.detail !== undefined && (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 2, lineHeight: 1.5, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{step.detail}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The host removal went wrong: what happened, and the three things the person can do. The row is still registered. */
function HostFailure({ deletion }: DeleteServerPanelProps) {
  const { t } = useTranslation('servers');
  const { failure, busy, rowError } = deletion;
  if (failure === null) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <Notice tone="danger" sub={t('danger.hostRemoval.failedKeepsServer')}>
        {t('danger.hostRemoval.failedTitle')}
      </Notice>
      {failure.kind === 'steps'
        ? <StepList steps={failure.steps} />
        : (
          <div role="status" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>
            {failure.message === '' ? t('danger.hostRemoval.failedUnknown') : t('danger.hostRemoval.failedNoAnswer', { reason: failure.message })}
          </div>
        )}
      {rowError !== null && <Notice tone="danger">{t('danger.hostRemoval.rowFailed', { reason: rowError })}</Notice>}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button onClick={deletion.cancel} disabled={busy}>{t('common:actions.cancel')}</Button>
        <Button onClick={() => void deletion.confirm()} disabled={busy}>{t('danger.hostRemoval.retry')}</Button>
        <Button variant="danger" onClick={() => void deletion.deleteEntryOnly()} loading={busy} loadingLabel={t('danger.deleting')}>
          {t('danger.hostRemoval.deleteEntryOnly')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The confirmation of deleting a server. For a Windows agent it offers to remove the agent from the host first (default on) and,
 * as a separate choice that closes every window of the host, the misao beside it (default off, only with the first). Other agents
 * say why the host is not touched (#499). With the host removal off (or not available) it says what stays on the host and links the
 * manual steps. A failed host removal shows every step's result and lets the person try again, delete only the entry, or cancel.
 */
export function DeleteServerPanel({ deletion }: DeleteServerPanelProps) {
  const { t } = useTranslation('servers');
  const { phase, support, choice, busy, rowError } = deletion;
  if (phase === 'idle') return null;
  if (phase === 'hostFailed') return <HostFailure deletion={deletion} />;

  const touchesHost = support === 'windows' && choice.removeFromHost;
  const showStays = support !== 'none' && !touchesHost;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {support === 'windows' && (
        <div role="group" aria-label={t('danger.hostRemoval.groupLabel')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <ToggleField
            checked={choice.removeFromHost}
            onChange={deletion.setRemoveFromHost}
            label={t('danger.hostRemoval.removeFromHost')}
            description={t('danger.hostRemoval.removeFromHostDesc')}
            disabled={busy}
          />
          <ToggleField
            checked={choice.removeMisao}
            onChange={deletion.setRemoveMisao}
            label={t('danger.hostRemoval.removeMisao')}
            description={choice.removeFromHost ? t('danger.hostRemoval.removeMisaoDesc') : t('danger.hostRemoval.removeMisaoNeedsHost')}
            disabled={busy || !choice.removeFromHost}
          />
        </div>
      )}
      {support === 'unsupported' && <Notice tone="info">{t('danger.hostRemoval.unsupported')}</Notice>}
      {showStays && (
        <Notice
          tone="warning"
          sub={(
            <>
              {t('danger.hostRemoval.staysHarness')}{' '}
              <DocsLink page="install-and-update" label={t('danger.hostRemoval.manualSteps')} />
            </>
          )}
        >
          <strong>{t('danger.hostRemoval.staysTitle')}</strong>{' '}
          {support === 'windows' ? t('danger.hostRemoval.staysWindows') : t('danger.hostRemoval.staysUnix')}
        </Notice>
      )}
      <div aria-live="polite" style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', minHeight: 0 }}>
        {phase === 'removingHost' && t('danger.hostRemoval.removingHost')}
      </div>
      {rowError !== null && <Notice tone="danger">{t('danger.hostRemoval.rowFailed', { reason: rowError })}</Notice>}
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button onClick={deletion.cancel} disabled={busy}>{t('common:actions.cancel')}</Button>
        <Button
          variant="danger"
          onClick={() => void deletion.confirm()}
          loading={busy}
          loadingLabel={phase === 'removingHost' ? t('danger.hostRemoval.removingHost') : t('danger.deleting')}
        >
          {t('common:actions.confirm')}
        </Button>
      </div>
    </div>
  );
}
