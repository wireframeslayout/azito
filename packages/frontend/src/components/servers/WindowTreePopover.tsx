import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Session, TmuxWindow } from '../../hooks/useServerManagement';
import { Icon } from '../ui/Icon';

interface WindowTreePopoverProps {
  sessions: Session[];
  serverName: string;
  selectedTarget: string | null;
  onSelect: (target: string) => void;
  onClose: () => void;
  onCreateSession: () => void;
  onAddWindow: (sessionName: string) => void;
  onSplitPane: (sessionName: string, windowName: string, direction: string) => void;
  isMobile: boolean;
}

export default function WindowTreePopover({
  sessions, serverName, selectedTarget,
  onSelect, onClose, onCreateSession, onAddWindow, onSplitPane, isMobile,
}: WindowTreePopoverProps) {
  const { t } = useTranslation('servers');
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(() => new Set(sessions.map((s) => s.name)));

  const toggleSession = (name: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const totalWindows = sessions.reduce((sum, s) => sum + s.windows.length, 0);

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
        const expanded = expandedSessions.has(sess.name);
        return (
          <div key={sess.name}>
            <TreeRow
              indent={0}
              onClick={() => toggleSession(sess.name)}
              selected={false}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', width: 10, color: 'var(--text-dim)' }}>
                <Icon name="chevron-right" size={14} rotate={expanded ? 90 : 0} />
              </span>
              <span style={{ fontFamily: 'var(--mono)' }}>{sess.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                {sess.windows.length} windows
              </span>
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginLeft: 10, cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); onAddWindow(sess.name); }}
              >
                <Icon name="plus" size={14} />Window
              </span>
            </TreeRow>
            {expanded && sess.windows.map((win) => {
              const winTarget = `${sess.name}:${win.name ?? win.index}`;
              return (
                <div key={win.index}>
                  <TreeRow
                    indent={1}
                    onClick={() => onSelect(winTarget)}
                    selected={selectedTarget === winTarget}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', width: 10, color: 'var(--text-dim)' }}>
                      <Icon name="chevron-right" size={14} />
                    </span>
                    <span style={{ fontFamily: 'var(--mono)' }}>{win.name ?? `win-${win.index}`}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
                      {win.panes.length} pane{win.panes.length > 1 ? 's' : ''}
                    </span>
                    <span
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginLeft: 10, cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSplitPane(sess.name, String(win.name ?? win.index), 'horizontal');
                      }}
                    >
                      <Icon name="split-h" size={14} /> {t('windows.split')}
                    </span>
                  </TreeRow>
                  {win.panes.map((pane) => {
                    const paneTarget = `${sess.name}:${win.name ?? win.index}.${pane.index}`;
                    return (
                      <TreeRow
                        key={pane.index}
                        indent={2}
                        onClick={() => onSelect(paneTarget)}
                        selected={selectedTarget === paneTarget}
                      >
                        <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-dim)' }}>.{pane.index}</span>
                        <span style={{ fontFamily: 'var(--mono)' }}>{pane.title || pane.command}</span>
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
