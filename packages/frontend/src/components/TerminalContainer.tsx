import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './ui/IconButton';
import { Icon } from './ui/Icon';
import { SegmentedToggle, type SegmentedToggleOption } from './ui/SegmentedToggle';
import { WindowStatusDropdown, findWindow } from './WindowStatusDropdown';
import XTermView from './XTermView';
import WindowChatPanel from './transcript/WindowChatPanel';
import { StyleSwitcher } from './transcript/StyleSwitcher';
import { useTranscriptStyle } from './transcript/transcriptStyle';
import ResourceWarningDialog, { type ResourceStatus } from './ResourceWarningDialog';
import { api } from '../api/client';
import { isInsufficientResources } from '../hooks/useAddWindowModal';
import type { Project, Task, Session } from '../pages/workspace/types';
import { resolveActivePane, paneDisplayName } from '../lib/tmuxPane';

type WindowViewMode = 'terminal' | 'chat';

function viewModeStorageKey(windowId: number): string {
  return `azito.windowView.${windowId}`;
}

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
  const [connectFailed, setConnectFailed] = useState(false);
  const [xtermKey, setXtermKey] = useState(0);

  const prevReconnectKey = useRef(reconnectKey);
  useEffect(() => {
    if (reconnectKey !== undefined && reconnectKey !== prevReconnectKey.current) {
      setWindowMissing(false);
      setDisconnected(false);
      setConnectFailed(false);
      setRespawnError(null);
      setXtermKey((k) => k + 1);
    }
    prevReconnectKey.current = reconnectKey;
  }, [reconnectKey]);
  const [respawning, setRespawning] = useState(false);
  const [respawnError, setRespawnError] = useState<string | null>(null);
  const [resourceWarning, setResourceWarning] = useState<{ resources: ResourceStatus; retry: () => void } | null>(null);

  // 端末⇄チャット切替（Issue #69 Phase E-2）にはウィンドウの永続 id が必要なため、windowMissing に
  // 関係なく常に解決する（respawn 導線の従来挙動は変えない）。project/allTasks 経由で見つからない
  // 表示経路（プレーンな pane 直接表示等）では windowId は null になり、トグル自体を出さない。
  const dbWindow = useMemo(
    () => findWindow(serverName, target, project ?? null, allTasks ?? []),
    [serverName, target, project, allTasks],
  );
  const windowId = dbWindow?.id ?? null;

  const [style, setStyle] = useTranscriptStyle();

  const [viewMode, setViewModeState] = useState<WindowViewMode>('terminal');
  useEffect(() => {
    if (windowId === null) {
      setViewModeState('terminal');
      return;
    }
    const stored = localStorage.getItem(viewModeStorageKey(windowId));
    setViewModeState(stored === 'chat' ? 'chat' : 'terminal');
  }, [windowId]);

  const setViewMode = useCallback((mode: WindowViewMode) => {
    setViewModeState(mode);
    if (windowId !== null) localStorage.setItem(viewModeStorageKey(windowId), mode);
  }, [windowId]);

  const viewModeOptions: SegmentedToggleOption<WindowViewMode>[] = useMemo(() => [
    { value: 'terminal', label: t('terminal.viewMode.terminal'), icon: 'terminal' },
    { value: 'chat', label: t('terminal.viewMode.chat'), icon: 'transcript' },
  ], [t]);

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
      setConnectFailed(false);
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
    setConnectFailed(false);
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
        <div style={{ marginLeft: activePaneName ? undefined : 'auto', display: 'flex', alignItems: 'center', gap: 8, paddingRight: 4 }}>
          {windowId !== null && viewMode === 'chat' && (
            // チャット表示中のみ表示スタイル切替を出す（Issue #69 調整1）。端末⇄チャットトグルの隣に
            // 置くのが自然と判断: ConversationView 埋め込み時はページ自前ヘッダーを描画しないため、
            // このツールバーが唯一の置き場所になる。WindowChatPanel/ConversationView 内部へ置く案も
            // あったが、分割ペインで同windowを複数開いた場合にも一貫してツールバーに出したいのと、
            // 端末/チャット切替という「表示モードの制御」の並びに揃えるため、ツールバー側を採用。
            <StyleSwitcher value={style} onChange={setStyle} compact />
          )}
          {windowId !== null && (
            <SegmentedToggle
              options={viewModeOptions}
              value={viewMode}
              onChange={setViewMode}
              ariaLabel={t('terminal.viewMode.ariaLabel')}
            />
          )}
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
        {viewMode === 'chat' && windowId !== null ? (
          <WindowChatPanel windowId={windowId} />
        ) : (
          <>
        {!windowMissing && (
          <XTermView
            key={xtermKey}
            serverName={serverName}
            target={target}
            onDisconnect={onDisconnect}
            onWindowNotFound={() => setWindowMissing(true)}
            onMaxRetriesReached={() => setDisconnected(true)}
            onConnectTimeout={() => setConnectFailed(true)}
          />
        )}
        {connectFailed && !windowMissing && !disconnected && (
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
              {t('terminal.connectFailed')}
            </div>
            {taskId !== undefined && (
              <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', maxWidth: 320, textAlign: 'center' }}>
                {t('terminal.connectFailedTaskHint')}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => { setConnectFailed(false); setXtermKey((k) => k + 1); }}
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
          </>
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
