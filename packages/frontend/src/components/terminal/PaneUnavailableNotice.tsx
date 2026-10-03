import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { OpenPaneForm } from './OpenPaneForm';
import { api } from '../../api/client';
import { errorMessageOf } from '../../lib/apiResult';
import type { PaneUnavailableReason } from '../../lib/paneState';
import { paneApiPath, windowKillRequest, type TerminalRef } from '../../lib/terminalRef';

export type PaneNoticeOutcome = 'pane_deleted' | 'pane_opened' | 'window_deleted';

interface PaneUnavailableNoticeProps {
  reason: PaneUnavailableReason;
  terminalRef: TerminalRef;
  /** Formatted MuxRef of the window, needed to open a pane in it. */
  muxRef: string;
  onResolved: (outcome: PaneNoticeOutcome) => void;
}

type Busy = 'delete_pane' | 'kill_window' | null;

/**
 * Overlay shown instead of a terminal when the hub refuses to attach: a stopped pane (restored by a restarted
 * misao daemon) or a window without panes. Offers the ways out: delete the pane, or open a pane / delete the window.
 */
export function PaneUnavailableNotice({ reason, terminalRef, muxRef, onResolved }: PaneUnavailableNoticeProps) {
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFormShown, setOpenFormShown] = useState(false);

  async function run(kind: Exclude<Busy, null>, outcome: PaneNoticeOutcome, path: string, method: 'DELETE' | 'POST'): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      const failure = errorMessageOf(await api<unknown>(path, { method }));
      if (failure) {
        setError(failure);
        return;
      }
      onResolved(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function handleDeletePane(): void {
    void run('delete_pane', 'pane_deleted', paneApiPath(terminalRef), 'DELETE');
  }

  function handleKillWindow(): void {
    const { path, method } = windowKillRequest(terminalRef);
    void run('kill_window', 'window_deleted', path, method);
  }

  const isBusy = busy !== null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        zIndex: 6,
        gap: 16,
        padding: 16,
      }}
    >
      <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-base)', maxWidth: 360, textAlign: 'center', lineHeight: 1.6 }}>
        {reason === 'pane_stopped' ? t('terminal.paneUnavailable.stopped') : t('terminal.paneUnavailable.emptyWindow')}
      </div>
      {error && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--font-sm)', maxWidth: 320, textAlign: 'center' }}>
          {error}
        </div>
      )}
      {reason === 'pane_stopped' && (
        <Button variant="danger" size="sm" onClick={handleDeletePane} loading={busy === 'delete_pane'} loadingLabel={t('terminal.paneUnavailable.deleting')}>
          {t('terminal.paneUnavailable.deletePane')}
        </Button>
      )}
      {reason === 'window_empty' && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button variant="primary" size="sm" onClick={() => setOpenFormShown((shown) => !shown)} disabled={isBusy} aria-expanded={openFormShown}>
              {t('terminal.paneUnavailable.openPane')}
            </Button>
            <Button size="sm" onClick={handleKillWindow} loading={busy === 'kill_window'} loadingLabel={t('terminal.paneUnavailable.deleting')}>
              {t('terminal.paneUnavailable.killWindow')}
            </Button>
          </div>
          {openFormShown && (
            <OpenPaneForm serverName={terminalRef.serverName} muxRef={muxRef} onOpened={() => onResolved('pane_opened')} />
          )}
        </>
      )}
    </div>
  );
}
