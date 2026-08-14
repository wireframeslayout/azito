import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './ui/IconButton';
import { Icon } from './ui/Icon';
import { SegmentedToggle, type SegmentedToggleOption } from './ui/SegmentedToggle';
import { WindowStatusDropdown, findWindow } from './WindowStatusDropdown';
import XTermView, { type XTermViewHandle } from './XTermView';
import WindowChatPanel from './transcript/WindowChatPanel';
import { StyleSwitcher } from './transcript/StyleSwitcher';
import { useTranscriptStyle } from './transcript/transcriptStyle';
import ResourceWarningDialog, { type ResourceStatus } from './ResourceWarningDialog';
import { TerminalQuickKeyBar } from './workspace/TerminalQuickKeyBar';
import { TerminalChatToggle } from './ui/TerminalChatToggle';
import { MobileKeyboardOverlay } from './ui/MobileKeyboardOverlay';
import { api } from '../api/client';
import { isInsufficientResources } from '../hooks/useAddWindowModal';
import { useIsMobile } from '../hooks/useIsMobile';
import { useWorkspaceTargets } from '../hooks/useWorkspaceTargets';
import type { Project, Task, Session } from '../pages/workspace/types';
import { resolveActivePane, paneDisplayName } from '../lib/tmuxPane';

export type WindowViewMode = 'terminal' | 'chat';

export function viewModeStorageKey(windowId: number): string {
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
  /**
   * SP タスク画面の「ウィンドウ」セグメント（Issue #69 修正3）向け: ウィンドウ選択
   * ドロップダウン等をこのツールバーの先頭に差し込む。既存の端末⇄チャットトグル
   * （Issue #69 Phase E-2）と同じツールバー行に並べることで、承認済みモックの
   * 「ウィンドウバー＋右端にトグル」を1本のバーとして実現する — 呼び出し元が
   * 明示的に渡さない限り何も描画しない（デスクトップ/他の呼び出し元は無変更）。
   */
  leading?: React.ReactNode;
  /**
   * SP コンテンツヘッダー右端（Issue #69 S8: 「∨ Nペイン」チップ等）に差し込む要素。leading と
   * 対称の位置づけ — SP では WindowStatusDropdown（ワーカーバッジ）の後ろに並べる。デスクトップは
   * 使わない（渡されない）。
   */
  trailing?: React.ReactNode;
  /**
   * 端末/チャットの表示モードを外部（呼び出し元）が完全に制御する（Issue #69 T5）。
   * SP タスク画面ではこの表示モード選択自体が下端ミニトグル（qbar/PromptInputBar 左端、
   * Issue #69 S8）に一本化されたため、TaskPanel 側が単一の真実源として azito.windowView.*
   * を読み書きし、その結果をここへ渡す。渡された場合はツールバー内蔵の端末⇄チャット
   * トグル（下記 SegmentedToggle、デスクトップのみ）を描画しない — 選択操作の入口が
   * ミニトグルのみになるようにするため（二重の切替UIを防ぐ）。変更は `onViewModeChange`
   * 経由で呼び出し元へ通知する（渡されない場合、ミニトグルは内部状態を直接更新する）。
   * 省略時（デスクトップ・タスク外の単体ウィンドウタブ等）は従来どおり内部状態＋
   * localStorage（windowId 単位）で自律的に管理する。
   */
  viewMode?: WindowViewMode;
  /** viewMode が外部制御（controlled）のときのみ使う変更コールバック。 */
  onViewModeChange?: (mode: WindowViewMode) => void;
}

export function TerminalContainer({ serverName, target, projectId, taskId, project, allTasks, sessions, onSplitPane, onOpenTask, onDisconnect, onWindowChanged, onCloseTab, onRetargetTab, reconnectKey, leading, trailing, viewMode: viewModeProp, onViewModeChange }: TerminalContainerProps) {
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

  const [internalViewMode, setInternalViewModeState] = useState<WindowViewMode>('terminal');
  useEffect(() => {
    if (viewModeProp !== undefined) return; // caller owns the value — see viewMode prop doc
    if (windowId === null) {
      setInternalViewModeState('terminal');
      return;
    }
    const stored = localStorage.getItem(viewModeStorageKey(windowId));
    setInternalViewModeState(stored === 'chat' ? 'chat' : 'terminal');
  }, [windowId, viewModeProp]);

  const setViewMode = useCallback((mode: WindowViewMode) => {
    setInternalViewModeState(mode);
    if (windowId !== null) localStorage.setItem(viewModeStorageKey(windowId), mode);
  }, [windowId]);

  const viewMode = viewModeProp ?? internalViewMode;

  // 下端ミニトグル（TerminalChatToggle、qbar/PromptInputBar 左端）が呼ぶ実際の変更経路。
  // 外部制御（viewModeProp が渡されている＝TaskPanel 配下）のときは呼び出し元通知のみ、
  // それ以外（タスク外の単体ウィンドウタブ等）は内部状態＋localStorage を自律更新する。
  const changeViewMode = viewModeProp !== undefined
    ? (mode: WindowViewMode) => onViewModeChange?.(mode)
    : setViewMode;

  const viewModeOptions: SegmentedToggleOption<WindowViewMode>[] = useMemo(() => [
    { value: 'terminal', label: t('terminal.viewMode.terminal'), icon: 'terminal' },
    { value: 'chat', label: t('terminal.viewMode.chat'), icon: 'transcript' },
  ], [t]);

  // SP端末クイックキーフッター＋⌨透過パッド（Issue #69 T3）。SP・端末ビュー表示中のみ
  // マウントする。キー送出は XTermView が公開する sendKey ハンドル（既存の
  // wsRef.send(SPECIAL_KEY_MAP[key]) 経路）をそのまま呼ぶだけで、ここでは新規の送出
  // 実装を持たない。⌨トグルの MobileKeyboardOverlay も同じハンドル経由で送出する。
  const isMobile = useIsMobile();
  const xtermRef = useRef<XTermViewHandle>(null);
  const [keyboardOverlayOpen, setKeyboardOverlayOpen] = useState(false);
  const { onOpenTabSwitcher } = useWorkspaceTargets();
  const showQuickKeyBar = isMobile && viewMode === 'terminal';

  const sendQuickKey = useCallback((key: string) => {
    xtermRef.current?.sendKey(key);
  }, []);

  useEffect(() => {
    if (!keyboardOverlayOpen) return;
    // 端末ビューを離れた／ウィンドウが切り替わったらパッドも閉じる
    if (!showQuickKeyBar) setKeyboardOverlayOpen(false);
  }, [showQuickKeyBar, keyboardOverlayOpen]);

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
        {leading && <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', paddingLeft: 4, minWidth: 0 }}>{leading}</div>}
        {/* SP: ウィンドウ名は leading（TaskPanel が「> ウィンドウ名」トリガーとして描画）が
            既に担うため、ここでは pane 名の重複表示をしない（承認済み S8 コンテンツヘッダー:
            「> ウィンドウ名」＋ワーカーバッジ▾＋右端「∨ Nペイン」の1行のみ）。デスクトップは
            従来どおり activePaneName（pane 名）を表示する。 */}
        {activePaneName && !isMobile && (
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
        <div style={{ marginLeft: (activePaneName && !isMobile) ? undefined : 'auto', display: 'flex', alignItems: 'center', gap: 8, paddingRight: 4, minWidth: 0 }}>
          {!isMobile && windowId !== null && viewMode === 'chat' && (
            // チャット表示中のみ表示スタイル切替を出す（Issue #69 調整1）。端末⇄チャットトグルの隣に
            // 置くのが自然と判断: ConversationView 埋め込み時はページ自前ヘッダーを描画しないため、
            // このツールバーが唯一の置き場所になる。WindowChatPanel/ConversationView 内部へ置く案も
            // あったが、分割ペインで同windowを複数開いた場合にも一貫してツールバーに出したいのと、
            // 端末/チャット切替という「表示モードの制御」の並びに揃えるため、ツールバー側を採用。
            // SP はこのツールバー自体がコンテンツヘッダーに置き換わり、🎨 は PromptInputBar の
            // 🕘 隣へ移設済み（Issue #69 S8）— ここでは isMobile を除外する。
            <StyleSwitcher value={style} onChange={setStyle} compact />
          )}
          {!isMobile && windowId !== null && viewModeProp === undefined && (
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
          {!isMobile && onSplitPane && <IconButton title={t('terminal.splitHorizontal')} onClick={() => onSplitPane('h')} size="sm"><Icon name="split-h" size={14} /></IconButton>}
          {!isMobile && onSplitPane && <IconButton title={t('terminal.splitVertical')} onClick={() => onSplitPane('v')} size="sm"><Icon name="split-v" size={14} /></IconButton>}
          {isMobile && trailing}
        </div>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {viewMode === 'chat' && windowId !== null ? (
          <WindowChatPanel
            windowId={windowId}
            viewMode={isMobile ? viewMode : undefined}
            onChangeViewMode={isMobile ? changeViewMode : undefined}
          />
        ) : (
          <>
        {!windowMissing && (
          <XTermView
            key={xtermKey}
            ref={xtermRef}
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
      {showQuickKeyBar && (
        <TerminalQuickKeyBar
          onSendKey={sendQuickKey}
          keyboardOpen={keyboardOverlayOpen}
          onToggleKeyboard={() => setKeyboardOverlayOpen((open) => !open)}
          onOpenTabSwitcher={() => onOpenTabSwitcher?.()}
          viewMode={viewMode}
          onChangeViewMode={changeViewMode}
        />
      )}
      {showQuickKeyBar && keyboardOverlayOpen && (
        <MobileKeyboardOverlay onSendKey={sendQuickKey} onClose={() => setKeyboardOverlayOpen(false)} />
      )}
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
