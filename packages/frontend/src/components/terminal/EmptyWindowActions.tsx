import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { OpenPaneForm } from './OpenPaneForm';
import { api } from '../../api/client';
import { errorMessageOf } from '../../lib/apiResult';
import { useConfirm } from '../../hooks/useConfirm';
import { windowKillRequest } from '../../lib/terminalRef';
import type { PaneNoticeOutcome } from './PaneUnavailableNotice';

interface EmptyWindowActionsProps {
  serverName: string;
  /** The window's DB id: killing by id also removes its DB rows. */
  windowId: number;
  /** Formatted MuxRef of the window, needed to open a pane in it. */
  muxRef: string;
  /** Name shown in the delete confirmation. */
  windowLabel: string;
  /** Called after a pane was opened or the window was deleted, so the caller can refresh its window list. */
  onChanged: (outcome: Extract<PaneNoticeOutcome, 'pane_opened' | 'window_deleted'>) => void;
}

/**
 * The ways out of a window that has no panes (a misao window stays after its last pane closed):
 * open a pane in it, or delete the window. Inline counterpart of the terminal's PaneUnavailableNotice.
 */
export function EmptyWindowActions({ serverName, windowId, muxRef, windowLabel, onChanged }: EmptyWindowActionsProps) {
  const { t } = useTranslation('common');
  const confirm = useConfirm();
  const [openFormShown, setOpenFormShown] = useState(false);
  const [openSubmitting, setOpenSubmitting] = useState(false);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleKillWindow(): Promise<void> {
    const ok = await confirm({ title: t('terminal.paneUnavailable.killWindowConfirmTitle'), message: t('terminal.paneUnavailable.killWindowConfirmMessage', { name: windowLabel }), danger: true });
    if (!ok) return;
    setKilling(true);
    setError(null);
    try {
      const { path, method } = windowKillRequest({ kind: 'windowId', serverName, windowId, pane: 1 });
      const failure = errorMessageOf(await api<unknown>(path, { method }));
      if (failure) {
        setError(failure);
        return;
      }
      onChanged('window_deleted');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setKilling(false);
    }
  }

  const isBusy = killing || openSubmitting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', padding: 'var(--space-1) var(--space-3) var(--space-2) 40px' }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" onClick={() => setOpenFormShown((shown) => !shown)} disabled={isBusy} aria-expanded={openFormShown}>
          {t('terminal.paneUnavailable.openPane')}
        </Button>
        <Button size="sm" onClick={() => void handleKillWindow()} disabled={isBusy} loading={killing} loadingLabel={t('terminal.paneUnavailable.deleting')}>
          {t('terminal.paneUnavailable.killWindow')}
        </Button>
      </div>
      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
          {error}
        </div>
      )}
      {openFormShown && (
        <OpenPaneForm
          serverName={serverName}
          muxRef={muxRef}
          onOpened={() => { setOpenFormShown(false); onChanged('pane_opened'); }}
          onSubmittingChange={setOpenSubmitting}
        />
      )}
    </div>
  );
}
