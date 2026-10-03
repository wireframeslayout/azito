import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { OpenPaneForm } from './OpenPaneForm';
import { api } from '../../api/client';
import { errorMessageOf } from '../../lib/apiResult';
import { useConfirm } from '../../hooks/useConfirm';
import { terminalRefFromWindow, windowKillRequest } from '../../lib/terminalRef';

interface EmptyWindowActionsProps {
  serverName: string;
  /** The window's DB id as reported by the session listing; null for a window without a DB row. */
  windowId: number | null;
  /** Formatted MuxRef of the window, needed to open a pane in it. */
  muxRef: string;
  /** Name shown in the delete confirmation. */
  windowLabel: string;
  /** Called after a pane was opened or the window was deleted, so the caller can refresh its window list. */
  onChanged?: () => void;
}

/**
 * The ways out of a window that has no panes (a misao window stays after its last pane closed):
 * open a pane in it, or delete the window. Inline counterpart of the terminal's PaneUnavailableNotice.
 */
export function EmptyWindowActions({ serverName, windowId, muxRef, windowLabel, onChanged }: EmptyWindowActionsProps) {
  const { t } = useTranslation('common');
  const { t: ts } = useTranslation('servers');
  const confirm = useConfirm();
  const [openFormShown, setOpenFormShown] = useState(false);
  const [openSubmitting, setOpenSubmitting] = useState(false);
  const [killing, setKilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleKillWindow(): Promise<void> {
    const ok = await confirm({ title: ts('confirm.killWindow'), message: ts('confirm.killWindowMessage', { name: windowLabel }), danger: true });
    if (!ok) return;
    setKilling(true);
    setError(null);
    try {
      const { path, method } = windowKillRequest(terminalRefFromWindow(serverName, windowId, muxRef, 1));
      const failure = errorMessageOf(await api<unknown>(path, { method }));
      if (failure) {
        setError(failure);
        return;
      }
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setKilling(false);
    }
  }

  const isBusy = killing || openSubmitting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 12px 8px 40px' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
          onOpened={() => { setOpenFormShown(false); onChanged?.(); }}
          onSubmittingChange={setOpenSubmitting}
        />
      )}
    </div>
  );
}
