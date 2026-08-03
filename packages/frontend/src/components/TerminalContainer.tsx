import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './ui/IconButton';
import { Icon } from './ui/Icon';
import { WindowStatusDropdown, findWindow } from './WindowStatusDropdown';
import XTermView from './XTermView';
import ResourceWarningDialog, { type ResourceStatus } from './ResourceWarningDialog';
import { api } from '../api/client';
import { isInsufficientResources } from '../hooks/useAddWindowModal';
import type { Project, Task, Session } from '../pages/workspace/types';
import { resolveActivePane, paneDisplayName } from '../lib/tmuxPane';

const SPINNER_KEYFRAMES_ID = 'terminal-container-spinner-keyframes';

function ensureSpinnerKeyframes(): void {
  if (typeof document === 'undefined' || document.getElementById(SPINNER_KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = SPINNER_KEYFRAMES_ID;
  style.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
  document.head.appendChild(style);
}

interface TerminalContainerProps {
  serverName: string;
  target: string;
  projectId?: number;
  taskId?: number;
  project?: Project | null;
  allTasks?: Task[];
  sessions?: Session[];
  onSplitPane?: (direction: 'h' | 'v') => void;
  onOpenTask?: (taskId: number, title: string) => void;
  onDisconnect?: () => void;
  onWindowChanged?: () => void;
  onCloseTab?: () => void;
  onRetargetTab?: (serverName: string, newTarget: string) => void;
  reconnectKey?: number;
}

export function TerminalContainer({ serverName, target, projectId, taskId, project, allTasks, sessions, onSplitPane, onOpenTask, onDisconnect, onWindowChanged, onCloseTab, onRetargetTab, reconnectKey }: TerminalContainerProps) {
  const { t } = useTranslation('common');
  const [windowMissing, setWindowMissing] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [xtermKey, setXtermKey] = useState(0);

  const prevReconnectKey = useRef(reconnectKey);
  useEffect(() => {
    if (reconnectKey !== undefined && reconnectKey !== prevReconnectKey.current) {
      setWindowMissing(false);
      setDisconnected(false);
      setRespawnError(null);
      setXtermKey((k) => k + 1);
    }
    prevReconnectKey.current = reconnectKey;
  }, [reconnectKey]);
  const [respawning, setRespawning] = useState(false);
  const [respawnError, setRespawnError] = useState<string | null>(null);
  const [resourceWarning, setResourceWarning] = useState<{ resources: ResourceStatus; retry: () => void } | null>(null);

  const dbWindow = useMemo(() => {
    if (!windowMissing) return null;
    return findWindow(serverName, target, project ?? null, allTasks ?? []);
  }, [windowMissing, serverName, target, project, allTasks]);

  const handleRespawn = useCallback(async function perform(force = false) {
    if (!dbWindow) return;
    setRespawning(true);
    setRespawnError(null);
    try {
      const res = await api<{ tmuxTarget: string; error?: string }>(`/windows/${dbWindow.id}/respawn`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      if (isInsufficientResources(res)) {
        setResourceWarning({
          resources: res.resources,
          retry: () => {
            setResourceWarning(null);
            void perform(true);
          },
        });
        return;
      }
      if (!res.tmuxTarget) {
        setRespawnError(res.error || 'Respawn failed');
        return;
      }
      setWindowMissing(false);
      setDisconnected(false);
      setRespawnError(null);
      setXtermKey((k) => k + 1);
      onRetargetTab?.(serverName, res.tmuxTarget);
      onWindowChanged?.();
    } catch (err) {
      setRespawnError(err instanceof Error ? err.message : 'Respawn failed');
    } finally {
      setRespawning(false);
    }
  }, [dbWindow, serverName, onRetargetTab, onWindowChanged]);

  const sessionsUpdateCount = useRef(0);
  const everSeen = useRef(false);
  useEffect(() => {
    if (!sessions) return;
    sessionsUpdateCount.current += 1;

    const colonIdx = target.indexOf(':');
    if (colonIdx < 0) return;
    const sessionName = target.slice(0, colonIdx);
    const rest = target.slice(colonIdx + 1);

    const session = sessions.find(s => s.name === sessionName);
    if (!session) {
      if (everSeen.current || sessionsUpdateCount.current > 1) setWindowMissing(true);
      return;
    }

    const dotIdx = rest.lastIndexOf('.');
    const winSpec = dotIdx >= 0 ? rest.slice(0, dotIdx) : rest;
    const paneSpec = dotIdx >= 0 ? rest.slice(dotIdx + 1) : null;

    const winIdx = parseInt(winSpec, 10);
    let tmuxWindow = Number.isNaN(winIdx)
      ? session.windows.find(w => w.name === winSpec)
      : session.windows.find(w => w.index === winIdx);

    if (!tmuxWindow && dotIdx >= 0) {
      const fullWin = session.windows.find(w => w.name === rest)
        ?? session.windows.find(w => String(w.index) === rest);
      if (fullWin) { tmuxWindow = fullWin; }
    }

    if (!tmuxWindow) {
      if (everSeen.current || sessionsUpdateCount.current > 1) setWindowMissing(true);
      return;
    }

    if (paneSpec !== null && /^\d+$/.test(paneSpec)) {
      const pIdx = parseInt(paneSpec, 10);
      if (!tmuxWindow.panes.some(p => p.index === pIdx)) {
        if (everSeen.current || sessionsUpdateCount.current > 1) setWindowMissing(true);
        return;
      }
    }

    everSeen.current = true;
    setWindowMissing(false);
    setDisconnected(false);
  }, [sessions, target]);

  const activePane = useMemo(
    () => sessions ? resolveActivePane(sessions, target) : null,
    [sessions, target],
  );
  const activePaneName = activePane ? paneDisplayName(activePane) : undefined;

  ensureSpinnerKeyframes();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        role="toolbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          background: 'var(--ws-surface)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        {activePaneName && (
          <div
            title={activePaneName}
            aria-live="polite"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--text-dim)',
              fontSize: 'var(--font-sm)',
              paddingLeft: 8,
            }}
          >
            <span aria-hidden="true" style={{ marginRight: 4, opacity: 0.5 }}>&gt;</span>
            {activePaneName}
          </div>
        )}
        <div style={{ marginLeft: activePaneName ? undefined : 'auto', display: 'flex', alignItems: 'center', gap: 2, paddingRight: 4 }}>
          <WindowStatusDropdown
            serverName={serverName}
            target={target}
            project={project ?? null}
            allTasks={allTasks ?? []}
            taskId={taskId}
            projectId={projectId}
            onOpenTask={onOpenTask}
            onChanged={onWindowChanged}
          />
          {onSplitPane && <IconButton title={t('terminal.splitHorizontal')} onClick={() => onSplitPane('h')} size="sm"><Icon name="split-h" size={14} /></IconButton>}
          {onSplitPane && <IconButton title={t('terminal.splitVertical')} onClick={() => onSplitPane('v')} size="sm"><Icon name="split-v" size={14} /></IconButton>}
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {!windowMissing && (
          <XTermView key={xtermKey} serverName={serverName} target={target} onDisconnect={onDisconnect} onWindowNotFound={() => setWindowMissing(true)} onMaxRetriesReached={() => setDisconnected(true)} />
        )}
        {disconnected && !windowMissing && (
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
              zIndex: 5,
              gap: 16,
            }}
          >
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-base)', marginBottom: 4 }}>
              {t('terminal.disconnected')}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => { setDisconnected(false); setXtermKey(k => k + 1); }}
              >
                {t('terminal.reconnect')}
              </button>
              {onCloseTab && (
                <button className="btn btn-sm" onClick={onCloseTab}>
                  {t('terminal.closeTab')}
                </button>
              )}
            </div>
          </div>
        )}
        {windowMissing && (
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
            }}
          >
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-base)', marginBottom: 4 }}>
              {t('terminal.windowMissing')}
            </div>
            {respawnError && (
              <div style={{ color: 'var(--danger)', fontSize: 'var(--font-sm)', maxWidth: 320, textAlign: 'center' }}>
                {respawnError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {dbWindow ? (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => handleRespawn()}
                  disabled={respawning}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  {respawning && (
                    <span
                      role="status"
                      aria-label="Respawning"
                      style={{
                        display: 'inline-block',
                        width: 12,
                        height: 12,
                        border: '2px solid rgba(255,255,255,0.3)',
                        borderTopColor: '#fff', // lint-allow: hex - loading-spinner ring segment, decorative and theme-independent
                        borderRadius: '50%',
                        animation: 'spin 0.6s linear infinite',
                      }}
                    />
                  )}
                  {respawning ? t('terminal.respawning') : t('terminal.respawn')}
                </button>
              ) : (
                <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
                  {t('terminal.unregisteredWindow')}
                </div>
              )}
              {onCloseTab && (
                <button className="btn btn-sm" onClick={onCloseTab}>
                  {t('terminal.closeTab')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <ResourceWarningDialog
        open={resourceWarning !== null}
        title={t('resourceWarning.title')}
        resources={resourceWarning?.resources ?? null}
        actionLabel={t('resourceWarning.respawnAnyway')}
        onCancel={() => setResourceWarning(null)}
        onForce={() => resourceWarning?.retry()}
      />
    </div>
  );
}
