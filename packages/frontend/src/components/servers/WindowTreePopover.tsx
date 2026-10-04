import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MuxDriverKind } from '@azito/shared';
import type { Session } from '../../hooks/useServerManagement';
import { hasMixedKinds, sessionKey, sessionKindOf } from '../../lib/sessionKind';
import { terminalRefFromWindow, terminalTabId, type TerminalRef } from '../../lib/terminalRef';
import { resolveWindowDisplay, formatWindowDisplayLabel, sessionWindowLabel, type WindowIndexEntry } from '../../lib/windowDisplay';
import { isPaneLive, preferredPaneOrdinal } from '../../lib/paneState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { PaneStateChip, DIMMED_PANE_OPACITY } from '../ui/PaneStateChip';

interface WindowTreePopoverProps {
  sessions: Session[];
  serverName: string;
  selectedRef: TerminalRef | null;
  onSelect: (ref: TerminalRef) => void;
  onClose: () => void;
  onCreateSession: () => void;
  /** `kind`: the mux of the session (a tmux and a misao session can share a name). */
  onAddWindow: (sessionName: string, kind: MuxDriverKind) => void;
  onSplitPane: (sessionName: string, windowName: string, direction: string, windowId?: number, ref?: string) => void;
  /** Deletes one pane (a stopped or exited one, from its row). `label` names it in the confirmation. */
  onDeletePane: (ref: TerminalRef, label: string, handle?: string) => void;
  /** Deletes a whole window (the way out of a window without panes). `label` names it in the confirmation. */
  onKillWindow: (ref: TerminalRef, label: string) => void;
  isMobile: boolean;
  windowById: Map<number, WindowIndexEntry>;
  taskById: Map<number, { title?: string }>;
}

export default function WindowTreePopover({
  sessions, serverName, selectedRef,
  onSelect, onClose, onCreateSession, onAddWindow, onSplitPane, onDeletePane, onKillWindow, isMobile,
  windowById, taskById,
}: WindowTreePopoverProps) {
  const { t } = useTranslation('servers');
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set(sessions.map(sessionKey)));

  const toggleSession = (key: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const totalWindows = sessions.reduce((sum, s) => sum + s.windows.length, 0);
  // Only when two muxes are listed is the mux named on each session (it is what tells same-named sessions apart).
  const showKind = hasMixedKinds(sessions);
  const selectedId = selectedRef ? terminalTabId(selectedRef) : null;

  const content = (
    <>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)',
        letterSpacing: '.1em', color: 'var(--text-dim)',
        padding: '4px 8px 6px',
        display: 'flex', justifyContent: 'space-between',
      }}>
        <span>SESSIONS — {serverName}</span>
        <span>{sessions.length} session · {totalWindows} windows</span>
      </div>

      {sessions.map((sess) => {
        const key = sessionKey(sess);
        const kind = sessionKindOf(sess);
        const expanded = expandedSessions.has(key);
        return (
          <div key={key}>
            <TreeRow
              indent={0}
              onClick={() => toggleSession(key)}
              selected={false}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', width: 10, color: 'var(--text-dim)' }}>
                <Icon name="chevron-right" size={14} rotate={expanded ? 90 : 0} />
              </span>
              <span style={{ fontFamily: 'var(--mono)', opacity: sess.stale ? DIMMED_PANE_OPACITY : undefined }}>{sess.name}</span>
              {showKind && <Chip>{t(kind === 'misao' ? 'overview.defaultMuxMisao' : 'overview.defaultMuxTmux')}</Chip>}
              {/* Kept from an earlier listing: its mux cannot be listed right now. */}
              {sess.stale && <Chip>{t('status.offline')}</Chip>}
              <span style={{ marginLeft: 'auto', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                {sess.windows.length} windows
              </span>
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginLeft: 10, cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); onAddWindow(sess.name, kind); }}
              >
                <Icon name="plus" size={14} />Window
              </span>
            </TreeRow>
            {expanded && sess.windows.map((win) => {
              // A window opens on a live pane when it has one (a restarted misao daemon leaves stopped panes first).
              const winRef = terminalRefFromWindow(serverName, win.windowId, win.ref, preferredPaneOrdinal(win) ?? 1);
              const winRefId = terminalTabId(winRef);
              const winLabel = sessionWindowLabel(sess.name, win);
              const isEmptyWindow = win.panes.length === 0;
              return (
                <div key={win.index}>
                  <TreeRow
                    indent={1}
                    onClick={() => onSelect(winRef)}
                    selected={selectedId === winRefId}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', width: 10, color: 'var(--text-dim)' }}>
                      <Icon name="chevron-right" size={14} />
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{
                      (() => {
                        const regWin = win.windowId != null ? windowById.get(win.windowId) : undefined;
                        const display = resolveWindowDisplay({
                          windowId: win.windowId ?? undefined,
                          paneTitle: win.panes[0]?.title,
                          paneCommand: win.panes[0]?.command,
                          label: regWin?.label,
                          workerType: regWin?.workerType,
                          windowType: regWin?.windowType,
                          taskTitle: regWin?.taskId != null ? taskById.get(regWin.taskId)?.title : undefined,
                          tmuxTarget: winLabel,
                        });
                        return formatWindowDisplayLabel(display);
                      })()
                    }</span>
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
                      {isEmptyWindow ? t('windows.noPanes') : `${win.panes.length} pane${win.panes.length > 1 ? 's' : ''}`}
                    </span>
                    {!isEmptyWindow && (
                      <span
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginLeft: 10, cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSplitPane(sess.name, String(win.name ?? win.index), 'horizontal', win.windowId ?? undefined, win.ref);
                        }}
                      >
                        <Icon name="split-h" size={14} /> {t('windows.split')}
                      </span>
                    )}
                  </TreeRow>
                  {isEmptyWindow && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `4px 9px 6px ${9 + 2 * 20}px` }}>
                      {/* Opening the window shows the pane-unavailable notice, which carries the open-pane form. */}
                      <Button size="sm" variant="primary" onClick={() => onSelect(winRef)}>{t('windows.openPane')}</Button>
                      <Button size="sm" onClick={() => onKillWindow(winRef, winLabel)}>{t('windows.killWindow')}</Button>
                    </div>
                  )}
                  {win.panes.map((pane) => {
                    const paneRef = terminalRefFromWindow(serverName, win.windowId, win.ref, pane.index);
                    return (
                      <TreeRow
                        key={pane.index}
                        indent={2}
                        onClick={() => onSelect(paneRef)}
                        selected={selectedId === terminalTabId(paneRef)}
                      >
                        <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>.{pane.index}</span>
                        <span style={{ fontFamily: 'var(--mono)', opacity: isPaneLive(pane) ? undefined : DIMMED_PANE_OPACITY }}>{pane.title || pane.command}</span>
                        <PaneStateChip pane={pane} />
                        {!isPaneLive(pane) && (
                          <IconButton
                            size="sm"
                            title={t('windows.deletePane', { name: `${winLabel}.${pane.index}` })}
                            aria-label={t('windows.deletePane', { name: `${winLabel}.${pane.index}` })}
                            style={{ marginLeft: 'auto' }}
                            onClick={(e) => { e.stopPropagation(); onDeletePane(paneRef, `${winLabel}.${pane.index}`, pane.handle); }}
                          >
                            <Icon name="trash" size={14} />
                          </IconButton>
                        )}
                      </TreeRow>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}

      <div style={{
        borderTop: '1px solid var(--border)', marginTop: 6,
        padding: '7px 8px 3px',
        display: 'flex', gap: 12,
        color: 'var(--text-dim)', fontSize: 'var(--font-xs)',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} onClick={onCreateSession}>
          <Icon name="plus" size={14} /> {t('windows.session')}
        </span>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <>
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 8 }}
          onClick={onClose}
        />
        <div style={{
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 9,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: '14px 14px 0 0',
          boxShadow: '0 -12px 34px rgba(0,0,0,.55)',
          padding: '8px 12px 14px',
          maxHeight: '70vh',
          overflow: 'auto',
        }}>
          <div style={{
            width: 34, height: 4, borderRadius: 'var(--radius-sm)',
            background: 'var(--border)', margin: '2px auto 10px',
          }} />
          {content}
        </div>
      </>
    );
  }

  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 8 }} onClick={onClose} />
      <div style={{
        position: 'absolute', left: 14, top: 46, zIndex: 9,
        width: 440, maxHeight: '60vh', overflow: 'auto',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 16px 40px rgba(0,0,0,.6)',
        padding: 8,
        fontSize: 'var(--font-xs)',
      }}>
        {content}
      </div>
    </>
  );
}

function TreeRow({
  children, indent, onClick, selected,
}: {
  children: React.ReactNode;
  indent: number;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: `6px 9px 6px ${9 + indent * 20}px`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        fontSize: 'var(--font-xs)',
        background: selected ? 'var(--selected-bg)' : 'transparent',
        transition: 'background 0.1s ease',
      }}
      onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </div>
  );
}
