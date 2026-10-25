import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, DocsLink, Notice, ToggleField } from '../../ui';
import { UninstallStepList } from '../UninstallStepList';
import type { ServerDeletion } from '../../../hooks/useServerDeletion';

interface DeleteServerPanelProps {
  deletion: ServerDeletion;
}

/** Why the row could not be deleted: visible text, read out by the live region of the panel (so it is hidden from the reader here, not said twice). */
function RowError({ reason }: { reason: string }) {
  const { t } = useTranslation('servers');
  return (
    <div aria-hidden="true" style={{ fontSize: 'var(--font-sm)', color: 'var(--danger)', overflowWrap: 'anywhere' }}>
      {t('danger.hostRemoval.rowFailed', { reason })}
    </div>
  );
}

/**
 * The host removal went wrong: what happened, and the three things the person can do. The row is still registered. This screen (with
 * the result it shows) stays while the entry is being deleted, and when that fails too; "try again" goes back to the choices to show
 * the progress. Focus moves to the heading when it appears, so a keyboard or screen reader user lands on the result instead of on nothing.
 */
function HostFailure({ deletion }: DeleteServerPanelProps) {
  const { t } = useTranslation('servers');
  const { failure, busy, rowError, deletingRow } = deletion;
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  if (failure === null) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      <div ref={heading} tabIndex={-1} style={{ outline: 'none' }}>
        <Notice tone="danger" sub={t('danger.hostRemoval.failedKeepsServer')}>
          {t('danger.hostRemoval.failedTitle')}
        </Notice>
      </div>
      {failure.kind === 'steps'
        ? <UninstallStepList steps={failure.steps} />
        : (
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>
            {failure.message === '' ? t('danger.hostRemoval.failedUnknown') : t('danger.hostRemoval.failedNoAnswer', { reason: failure.message })}
          </div>
        )}
      {rowError !== null && <RowError reason={rowError} />}
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button onClick={deletion.cancel} disabled={busy}>{t('common:actions.cancel')}</Button>
        <Button onClick={() => void deletion.confirm()} disabled={busy}>{t('danger.hostRemoval.retry')}</Button>
        <Button variant="danger" onClick={() => void deletion.deleteEntryOnly()} loading={deletingRow} disabled={busy} loadingLabel={t('danger.deleting')}>
          {t('danger.hostRemoval.deleteEntryOnly')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The choices (and, for a host that is not touched, what stays on it), with the buttons that start or abandon the deletion. Focus moves
 * to it when it appears (after "Delete", and after "try again", whose button is gone by then), and it stays put while the progress shows.
 */
function Choices({ deletion }: DeleteServerPanelProps) {
  const { t } = useTranslation('servers');
  const { phase, support, choice, busy, rowError } = deletion;
  const touchesHost = support === 'windows' && choice.removeFromHost;
  const showStays = support !== 'none' && !touchesHost;
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => { container.current?.focus(); }, []);
  return (
    <div ref={container} tabIndex={-1} role="group" aria-label={t('danger.deleteServer')} style={{ outline: 'none', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
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
              <DocsLink page={support === 'windows' ? 'windows-agent' : 'install-and-update'} label={t('danger.hostRemoval.manualSteps')} />
            </>
          )}
        >
          <strong>{t('danger.hostRemoval.staysTitle')}</strong>{' '}
          {support === 'windows' ? t('danger.hostRemoval.staysWindows') : t('danger.hostRemoval.staysUnix')}
        </Notice>
      )}
      {rowError !== null && <RowError reason={rowError} />}
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

/**
 * The confirmation of deleting a server. For a Windows agent it offers to remove the agent from the host first (default on) and,
 * as a separate choice that closes every window of the host, the misao beside it (default off, only with the first). Other agents
 * say why the host is not touched (#499). With the host removal off (or not available) it says what stays on the host and links the
 * manual steps. A failed host removal shows every step's result and lets the person try again, delete only the entry, or cancel.
 * It is always rendered, so its one live region exists before it has something to say and is read out when it does (the progress, and a
 * failure to delete the row).
 */
export function DeleteServerPanel({ deletion }: DeleteServerPanelProps) {
  const { t } = useTranslation('servers');
  const { phase, rowError } = deletion;
  const announcement = phase === 'removingHost'
    ? t('danger.hostRemoval.removingHost')
    : rowError !== null ? t('danger.hostRemoval.rowFailed', { reason: rowError }) : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: phase === 'idle' ? 0 : 'var(--space-4)' }}>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {phase === 'hostFailed' && <HostFailure deletion={deletion} />}
      {(phase === 'confirming' || phase === 'removingHost') && <Choices deletion={deletion} />}
    </div>
  );
}
