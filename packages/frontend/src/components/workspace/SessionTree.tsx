import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useContextMenu, type ContextMenuItem } from '../ContextMenu';
import ContextMenu from '../ContextMenu';
import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import type { Session, TmuxWindow } from '../../hooks/useServerManagement';
import { lookupWindowTask } from '../../lib/windowTask';
import { Icon } from '../ui/Icon';

interface SessionTreeProps {
  serverName: string;
  serverType: string;
  sessions: Session[];
  expandedSessions: Set<string>;
  activeTabId: string | null;
  reinstalling: string | null;
  onConnectPane: (serverName: string, target: string) => void;
  toggleSession: (sessionId: string) => void;
  getSessionMenuItems: (serverName: string, session: Session) => ContextMenuItem[];
  getWindowMenuItems: (serverName: string, sessionName: string, win: TmuxWindow, allWindows?: TmuxWindow[]) => ContextMenuItem[];
  getPaneMenuItems: (serverName: string, target: string, paneLabel: string) => ContextMenuItem[];
  handleAddWindow: (serverName: string, sessionName: string) => Promise<void>;
  windowTaskMap?: Map<string, number>;
}

export default function SessionTree({
  serverName, serverType, sessions, expandedSessions, activeTabId, reinstalling,
  onConnectPane, toggleSession,
  getSessionMenuItems, getWindowMenuItems, getPaneMenuItems,
  handleAddWindow, windowTaskMap,
}: SessionTreeProps) {
  const { t } = useTranslation('workspace');
  const { menu: contextMenu, show: showContextMenu, showAt: showContextMenuAt, hide: hideContextMenu } = useContextMenu();
  const bindLongPress = useLongPress();

  const showSessionContextMenu = useCallback((e: React.MouseEvent, session: Session) => {
    showContextMenu(e, getSessionMenuItems(serverName, session));
  }, [showContextMenu, getSessionMenuItems, serverName]);

  const showWindowContextMenu = useCallback((e: React.MouseEvent, sessionName: string, win: TmuxWindow, allWindows: TmuxWindow[]) => {
    showContextMenu(e, getWindowMenuItems(serverName, sessionName, win, allWindows));
  }, [showContextMenu, getWindowMenuItems, serverName]);

  const showPaneContextMenu = useCallback((e: React.MouseEvent, target: string, paneLabel: string) => {
    showContextMenu(e, getPaneMenuItems(serverName, target, paneLabel));
  }, [showContextMenu, getPaneMenuItems, serverName]);

  return (
    <>
      {reinstalling === serverName && (
        <div style={{ padding: '4px 8px 8px 28px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
          {t('sessionTree.installingAgent')}
        </div>
      )}

      {sessions.length === 0 && serverType !== 'local' && reinstalling !== serverName && (
        <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', padding: '4px 8px 8px 28px', fontStyle: 'italic' }}>
          {t('sessionTree.noSessions')}
        </div>
      )}

      {sessions.map((session) => {
        const sessionId = `${serverName}/${session.name}`;
        const isExpanded = expandedSessions.has(sessionId);
        return (
          <div key={sessionId} style={{ borderRadius: 'var(--radius-sm)', marginBottom: 2 }}>
            <div onClick={() => toggleSession(sessionId)}
              onContextMenu={(e) => { e.stopPropagation(); showSessionContextMenu(e, session); }}
              {...bindLongPress((x, y) => showContextMenuAt(x, y, getSessionMenuItems(serverName, session)))}
              style={{ ...longPressStyle, display: 'flex', alignItems: 'center', padding: '10px 8px', cursor: 'pointer', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-base)', gap: 8, minHeight: 44 }}>
              <span style={{ color: 'var(--text-dim)', width: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-right" size={14} rotate={isExpanded ? 90 : 0} /></span>
              <span style={{ flex: 1, fontWeight: 500 }}>{session.name}</span>
              {session.attached && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--success)' }} />}
              <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', background: 'var(--bg)', padding: '2px 8px', borderRadius: 'var(--radius-md)' }}>{session.windowCount}w</span>
            </div>

            {isExpanded && (
              <div style={{ paddingLeft: 22 }}>
                {session.windows.map((win) => {
                  const isUniqueName = session.windows.filter((w) => w.name === win.name).length === 1;
                  const windowId = isUniqueName ? win.name : String(win.index);
                  return (
                  <div key={win.index}>
                    <div
                      onContextMenu={(e) => showWindowContextMenu(e, session.name, win, session.windows)}
                      {...bindLongPress((x, y) => showContextMenuAt(x, y, getWindowMenuItems(serverName, session.name, win, session.windows)))}
                      style={{ ...longPressStyle, fontSize: 'var(--font-md)', color: 'var(--text-dim)', padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6, minHeight: 40, cursor: 'context-menu' }}
                    >
                      <span>{win.index}: {win.name}</span>
                      {(() => {
                        const taskId = windowTaskMap && (
                          lookupWindowTask(windowTaskMap, serverName, `${session.name}:${win.name}`)
                          ?? lookupWindowTask(windowTaskMap, serverName, `${session.name}:${windowId}`)
                        );
                        return taskId != null ? (
                          <span style={{
                            fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--bg-2, var(--bg))',
                            borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0, marginLeft: 'auto',
                          }}>
                            #{taskId}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    {win.panes.map((pane) => {
                      const target = `${session.name}:${windowId}.${pane.index}`;
                      const tabId = `terminal:${serverName}/${target}`;
                      const isActive = activeTabId === tabId;
                      const paneLabel = pane.title && pane.title !== pane.command ? pane.title : pane.command;
                      return (
                        <div key={pane.index} onClick={() => onConnectPane(serverName, target)}
                          onContextMenu={(e) => { e.stopPropagation(); showPaneContextMenu(e, target, paneLabel); }}
                          {...bindLongPress((x, y) => showContextMenuAt(x, y, getPaneMenuItems(serverName, target, paneLabel)))}
                          className={`row-hover${isActive ? ' row-selected' : ''}`}
                          style={{
                            ...longPressStyle,
                            fontSize: 'var(--font-md)', padding: '8px 8px 8px 36px', cursor: 'pointer', borderRadius: 'var(--radius-sm)',
                            display: 'flex', alignItems: 'center', gap: 8, minHeight: 44,
                            color: isActive ? 'var(--accent)' : 'inherit',
                          }}>
                          <span style={{ fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace", fontSize: 'var(--font-sm)' }}>
                            <span style={{ color: 'var(--text-dim)', marginRight: 6, fontSize: 'var(--font-xs)' }}>%{pane.index}</span>
                            {paneLabel}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  );
                })}
                <div style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', padding: '6px 8px', minHeight: 40 }}>
                  <button onClick={() => handleAddWindow(serverName, session.name)} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 'var(--font-md)', padding: '4px 0' }}>+ {t('windows.addWindow')}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {contextMenu && <ContextMenu menu={contextMenu} onClose={hideContextMenu} />}
    </>
  );
}
