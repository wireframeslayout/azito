import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui';
import { OpenPaneForm } from './OpenPaneForm';
import { api } from '../../api/client';
import { errorMessageOf } from '../../lib/apiResult';
import { paneNoticeActions, type PaneUnavailableReason } from '../../lib/paneState';
import { paneApiPath, windowKillRequest, type TerminalRef } from '../../lib/terminalRef';

export type PaneNoticeOutcome = 'pane_deleted' | 'pane_opened' | 'window_deleted' | 'switch_first_pane' | 'close_tab';

interface PaneUnavailableNoticeProps {
  reason: PaneUnavailableReason;
  terminalRef: TerminalRef;
  /** Formatted MuxRef of the window, needed to open a pane in it. */
  muxRef: string;
  onResolved: (outcome: PaneNoticeOutcome) => void;
  /** Brings a stopped task pane's agent back with its conversation. Absent for a window that has no agent to resume. */
  onResume?: () => void;
  resuming?: boolean;
  resumeError?: string | null;
}

const MESSAGE_KEYS: Record<PaneUnavailableReason, string> = {
  pane_stopped: 'terminal.paneUnavailable.stopped',
  window_empty: 'terminal.paneUnavailable.emptyWindow',
  pane_closed: 'terminal.paneUnavailable.closed',
};

type Busy = 'delete_pane' | 'kill_window' | null;

/**
 * Overlay shown instead of a terminal when the hub refuses to attach: a stopped pane (restored by a restarted
 * misao daemon), a window without panes, or a pane that was closed while watched. Offers the ways out: resume or delete
 * the pane, open a pane / delete the window, or move to the window's first pane / close the tab.
 */
export function PaneUnavailableNotice({ reason, terminalRef, muxRef, onResolved, onResume, resuming = false, resumeError = null }: PaneUnavailableNoticeProps) {
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [openFormShown, setOpenFormShown] = useState(false);
  const [openSubmitting, setOpenSubmitting] = useState(false);

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

  const isBusy = busy !== null || openSubmitting || resuming;
  const actions = paneNoticeActions(reason, onResume !== undefined);

  return (
    <div
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
      <div role="status" aria-live="polite" style={{ color: 'var(--text-dim)', fontSize: 'var(--font-base)', maxWidth: 360, textAlign: 'center', lineHeight: 1.6 }}>
        {t(MESSAGE_KEYS[reason])}
      </div>
      {(error ?? resumeError) && (
        <div role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--font-sm)', maxWidth: 320, textAlign: 'center' }}>
          {error ?? resumeError}
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
        {actions.includes('resume') && (
          <Button variant="primary" size="sm" onClick={onResume} disabled={isBusy && !resuming} loading={resuming} loadingLabel={t('terminal.paneUnavailable.resuming')}>
            {t('terminal.paneUnavailable.resume')}
          </Button>
        )}
        {actions.includes('delete_pane') && (
          <Button variant="danger" size="sm" onClick={handleDeletePane} disabled={isBusy && busy !== 'delete_pane'} loading={busy === 'delete_pane'} loadingLabel={t('terminal.paneUnavailable.deleting')}>
            {t('terminal.paneUnavailable.deletePane')}
          </Button>
        )}
        {actions.includes('open_pane') && (
          <Button variant="primary" size="sm" onClick={() => setOpenFormShown((shown) => !shown)} disabled={isBusy} aria-expanded={openFormShown}>
            {t('terminal.paneUnavailable.openPane')}
          </Button>
        )}
        {actions.includes('kill_window') && (
          <Button size="sm" onClick={handleKillWindow} disabled={isBusy} loading={busy === 'kill_window'} loadingLabel={t('terminal.paneUnavailable.deleting')}>
            {t('terminal.paneUnavailable.killWindow')}
          </Button>
        )}
        {actions.includes('open_first_pane') && (
          <Button variant="primary" size="sm" onClick={() => onResolved('switch_first_pane')}>
            {t('terminal.paneUnavailable.openFirstPane')}
          </Button>
        )}
        {actions.includes('close_tab') && (
          <Button size="sm" onClick={() => onResolved('close_tab')}>
            {t('terminal.paneUnavailable.closeTab')}
          </Button>
        )}
      </div>
      {actions.includes('open_pane') && openFormShown && (
        <OpenPaneForm serverName={terminalRef.serverName} muxRef={muxRef} onOpened={() => onResolved('pane_opened')} onSubmittingChange={setOpenSubmitting} />
      )}
    </div>
  );
}
