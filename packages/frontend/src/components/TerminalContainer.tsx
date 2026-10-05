import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from './ui/IconButton';
import { Icon } from './ui/Icon';
import { SegmentedToggle, type SegmentedToggleOption } from './ui/SegmentedToggle';
import { WindowStatusDropdown, findWindow, isTaskOwnedWindow } from './WindowStatusDropdown';
import { TaskOwnedPaneBadge } from './workspace/TaskOwnedPaneBadge';
import XTermView, { type XTermViewHandle } from './XTermView';
import WindowChatPanel from './transcript/WindowChatPanel';
import { StyleSwitcher } from './transcript/StyleSwitcher';
import { useTranscriptStyle } from './transcript/transcriptStyle';
import ResourceWarningDialog, { type ResourceStatus } from './ResourceWarningDialog';
import { TerminalQuickKeyBar } from './workspace/TerminalQuickKeyBar';
import { TerminalChatToggle } from './ui/TerminalChatToggle';
import { MobileKeyboardOverlay } from './ui/MobileKeyboardOverlay';
import { PaneUnavailableNotice, type PaneNoticeOutcome } from './terminal/PaneUnavailableNotice';
import { api } from '../api/client';
import { formatWindowId } from '@azito/shared';
import { useServerStatuses } from '../hooks/useServerStatuses';
import { isInsufficientResources } from '../hooks/useAddWindowModal';
import { useIsMobile } from '../hooks/useIsMobile';
import { useWorkspaceTargets } from '../hooks/useWorkspaceTargets';
import type { Project, Task, Session } from '../pages/workspace/types';
import { resolveTerminalTarget, resolveTabTargetRef, type TerminalRef } from '../lib/terminalRef';
import { PENDING_TERMINAL_OPEN_TTL_MS } from '../lib/terminalTargetOpen';
import { resolveActivePane, checkWindowExists, resolveActivePaneByRef, findPaneHandle } from '../lib/tmuxPane';
import { fetchSessionsOrUndefined } from '../lib/fetchServerSessions';
import { paneDisplayName } from '../lib/paneDisplay';
import { missingPaneOutcome, resumableWindowId, type PaneUnavailableReason } from '../lib/paneState';
import { refKindOf } from '../lib/sessionKind';

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
  terminalRef?: TerminalRef;
  /** The tab was opened by target string only: connect with `target=` and let the server resolve the window. */
  resolveOnServer?: boolean;
  projectId?: number;
  taskId?: number;
  /** The registered window this terminal shows, for callers that cannot pass project / allTasks to resolve it. */
  registeredWindow?: { id: number; taskId?: number | null };
  project?: Project | null;
  allTasks?: Task[];
  sessions?: Session[];
  onSplitPane?: (direction: 'h' | 'v') => void;
  onOpenTask?: (taskId: number, title: string) => void;
  onDisconnect?: () => void;
  onWindowChanged?: () => void;
  onCloseTab?: () => void;
  /** Called when the pane or window this terminal shows was deleted from the pane-unavailable notice (its ordinal is gone). Falls back to onCloseTab. */
  onTargetRemoved?: () => void;
  /** Re-points this terminal at another pane of its window (a pane opened in an empty window is pane 1). */
  onRetargetPane?: (pane: number) => void;
  onRetargetTab?: (serverName: string, windowId: number, sessions?: Session[]) => void;
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

export function TerminalContainer({ registeredWindow, serverName, target: rawTarget, terminalRef: terminalRefProp, resolveOnServer, projectId, taskId, project, allTasks, sessions, onSplitPane, onOpenTask, onDisconnect, onWindowChanged, onCloseTab, onTargetRemoved, onRetargetPane, onRetargetTab, reconnectKey, leading, trailing, viewMode: viewModeProp, onViewModeChange }: TerminalContainerProps) {
  // Tabs opened through connectPane carry a TerminalRef and a `w<id>` placeholder target;
  // everything below that still keys off a tmux target (window-exists check, status dropdown,
  // pane-loading-state fallback) needs the real `<session>:<window>.<pane>`, resolved from
  // sessions. Legacy callers (TaskPanel) pass a tmux target and no ref — derive the ref then.
  const { servers } = useServerStatuses();
  const muxKind = servers.find((s) => s.name === serverName)?.defaultMux;
  // Unknown until the server list arrives: registration then waits instead of guessing a mux kind.
  // A tab with a ref connects by it. Without one (a legacy tab not migrated yet, a task terminal before its window
  // is known) the target is resolved against sessions: until it can be, nothing connects — a tmux-kind ref guessed
  // for a misao window would be refused — and when it cannot be on a non-tmux server the window is missing.
  const tabRef = useMemo(
    () => (terminalRefProp ? { status: 'ready' as const, ref: terminalRefProp } : resolveTabTargetRef(serverName, rawTarget, { sessions, muxKind })),
    [terminalRefProp, serverName, rawTarget, sessions, muxKind],
  );
  const terminalRef = tabRef.status === 'ready' ? tabRef.ref : undefined;
  const refWaiting = tabRef.status === 'wait';
  // Sessions that do not arrive (the fetch failed, or the server is not among those fetched) must not leave the tab
  // on "connecting" for good: after the deadline the tab connects by target and the server resolves it.
  const [refWaitExpired, setRefWaitExpired] = useState(false);
  useEffect(() => {
    setRefWaitExpired(false);
    if (!refWaiting) return;
    const timer = setTimeout(() => setRefWaitExpired(true), PENDING_TERMINAL_OPEN_TTL_MS);
    return () => clearTimeout(timer);
  }, [refWaiting, serverName, rawTarget]);
  const refPending = refWaiting && !refWaitExpired && !resolveOnServer;
  const refUnresolved = tabRef.status === 'unresolved' && !resolveOnServer;
  const target = useMemo(() => {
    if (terminalRef) {
      return resolveTerminalTarget(terminalRef, sessions) ?? rawTarget;
    }
    return rawTarget;
  }, [rawTarget, terminalRef, sessions]);

  const { t } = useTranslation('common');
  const [windowMissingState, setWindowMissing] = useState(false);
  const windowMissing = windowMissingState || refUnresolved;
  const [paneUnavailable, setPaneUnavailable] = useState<PaneUnavailableReason | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  const [xtermKey, setXtermKey] = useState(0);

  const prevReconnectKey = useRef(reconnectKey);
  useEffect(() => {
    if (reconnectKey !== undefined && reconnectKey !== prevReconnectKey.current) {
      setWindowMissing(false);
      setPaneUnavailable(null);
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

  // Issue #28 Phase D-2 / Issue #69 Phase E-2: computed unconditionally (not just when
  // windowMissing, unlike the old dbWindow-only lookup) so the task-owned badge can reflect the
  // `windows` row's real ownerType/taskId regardless of pane liveness, and so the terminal⇄chat
  // toggle has the persisted window id available (respawn 導線の従来挙動は変えない). Where the
  // window isn't resolvable via project/allTasks (a plain pane direct view etc.), windowId is
  // null and the toggle itself is not rendered.
  const currentWindow = useMemo(
    () => findWindow(serverName, target, project ?? null, allTasks ?? [], terminalRef),
    [serverName, target, project, allTasks, terminalRef],
  );
  const isTaskOwnedPane = isTaskOwnedWindow(currentWindow);
  const dbWindow = currentWindow;
  const windowId = dbWindow?.id ?? null;
  // Callers without project / task data (the server detail page) name the registered window themselves.
  const respawnWindowId = dbWindow?.id ?? registeredWindow?.id ?? null;
  const canResume = resumableWindowId(dbWindow ?? registeredWindow) !== null;

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
    if (respawnWindowId === null) return;
    setRespawning(true);
    setRespawnError(null);
    try {
      const res = await api<{ tmuxTarget: string; error?: string; message?: string; windowId?: number }>(`/windows/${respawnWindowId}/respawn`, {
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
        if (res.error === 'session_already_running' && res.windowId != null) {
          setRespawnError(t('terminal.sessionAlreadyRunning', { windowId: formatWindowId(res.windowId) }));
        } else {
          setRespawnError(res.message || res.error || 'Respawn failed');
        }
        return;
      }
      setWindowMissing(false);
      setPaneUnavailable(null);
      setDisconnected(false);
      setConnectFailed(false);
      setRespawnError(null);
      setXtermKey((k) => k + 1);
      onRetargetTab?.(serverName, respawnWindowId, await fetchSessionsOrUndefined(serverName));
      onWindowChanged?.();
    } catch (err) {
      setRespawnError(err instanceof Error ? err.message : 'Respawn failed');
    } finally {
      setRespawning(false);
    }
  }, [respawnWindowId, serverName, onRetargetTab, onWindowChanged]);

  // The pane-unavailable notice can open a pane in the window, which needs the window's MuxRef.
  const windowMuxRef = useMemo<string | null>(() => {
    if (!terminalRef) return null;
    if (terminalRef.kind === 'ref') return terminalRef.ref;
    return sessions?.flatMap((sess) => sess.windows).find((w) => w.windowId === terminalRef.windowId)?.ref ?? null;
  }, [terminalRef, sessions]);
  // The mux the shown window lives in (a server can host tmux and misao windows side by side): its ref's kind. The
  // server's default mux stands in only while the window's ref is not known yet (a bare target is read in the default).
  const windowKind = refKindOf(windowMuxRef) ?? muxKind;

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [unavailablePaneHandle, setUnavailablePaneHandle] = useState<string | undefined>(undefined);
  const handlePaneUnavailable = useCallback((reason: PaneUnavailableReason) => {
    // Without the window's ref nothing in the notice can act on it: treat the window as gone.
    if (windowMuxRef === null) { setWindowMissing(true); return; }
    // Pinned now: a later delete targets this pane even if a sibling's removal shifts the ordinals.
    setUnavailablePaneHandle(terminalRef ? findPaneHandle(sessionsRef.current, terminalRef) : undefined);
    setPaneUnavailable(reason);
  }, [windowMuxRef, terminalRef]);

  const handlePaneNoticeResolved = useCallback((outcome: PaneNoticeOutcome) => {
    setPaneUnavailable(null);
    if (outcome === 'close_tab') { (onTargetRemoved ?? onCloseTab)?.(); return; }
    setXtermKey((k) => k + 1);
    if (outcome === 'switch_first_pane') {
      // The user chose to look at whatever pane is first now; the closed pane's number is not reused implicitly.
      if (terminalRef && terminalRef.pane !== 1) onRetargetPane?.(1);
      return;
    }
    onWindowChanged?.();
    // A deleted pane shifts the ordinals after it and a deleted window is gone: this terminal's target no longer exists.
    if (outcome !== 'pane_opened') { (onTargetRemoved ?? onCloseTab)?.(); return; }
    // The pane opened in an empty window is its only pane, so a terminal aimed at a later ordinal must move to it.
    if (terminalRef && terminalRef.pane !== 1) onRetargetPane?.(1);
  }, [onWindowChanged, onTargetRemoved, onCloseTab, onRetargetPane, terminalRef]);

  const sessionsUpdateCount = useRef(0);
  const everSeen = useRef(false);
  useEffect(() => {
    if (!sessions) return;
    // A tab the server resolves is judged by the server's answer (the WS error), not by sessions that may not list it.
    if (resolveOnServer && !terminalRef) return;
    sessionsUpdateCount.current += 1;

    const result = checkWindowExists(sessions, terminalRef, target);

    if (!result.found || !result.paneFound) {
      if (everSeen.current || sessionsUpdateCount.current > 1) {
        if (result.found && missingPaneOutcome(windowKind) === 'pane_closed') setPaneUnavailable('pane_closed');
        else setWindowMissing(true);
      }
      return;
    }

    everSeen.current = true;
    setWindowMissing(false);
    setDisconnected(false);
    setConnectFailed(false);
  }, [sessions, target, terminalRef, resolveOnServer, windowKind]);

  const activePane = useMemo(
    () => {
      if (!sessions) return null;
      if (terminalRef) return resolveActivePaneByRef(sessions, terminalRef);
      return resolveActivePane(sessions, target);
    },
    [sessions, terminalRef, target],
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
          {isTaskOwnedPane && <TaskOwnedPaneBadge />}
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
            sessions={sessions}
            terminalRef={terminalRef}
            muxKind={windowKind}
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
        {refPending && (
          <div
            role="status"
            aria-live="polite"
            style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--text-dim)', fontSize: 'var(--font-base)', zIndex: 6 }}
          >
            {t('terminal.connecting')}
          </div>
        )}
        {!windowMissing && !refPending && (
          <XTermView
            key={xtermKey}
            ref={xtermRef}
            serverName={serverName}
            target={target}
            terminalRef={terminalRef}
            onDisconnect={onDisconnect}
            onWindowNotFound={() => setWindowMissing(true)}
            onPaneUnavailable={handlePaneUnavailable}
            onMaxRetriesReached={() => setDisconnected(true)}
            onConnectTimeout={() => setConnectFailed(true)}
          />
        )}
        {paneUnavailable && terminalRef && windowMuxRef && !windowMissing && (
          <PaneUnavailableNotice
            reason={paneUnavailable}
            terminalRef={terminalRef}
            muxRef={windowMuxRef}
            paneHandle={unavailablePaneHandle}
            onResolved={handlePaneNoticeResolved}
            onResume={canResume ? () => { void handleRespawn(); } : undefined}
            resuming={respawning}
            resumeError={respawnError}
          />
        )}
        {connectFailed && !windowMissing && !disconnected && !paneUnavailable && (
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
              <button
                className="btn btn-sm"
                onClick={() => location.reload()}
              >
                {t('terminal.reloadPage')}
              </button>
              {onCloseTab && (
                <button className="btn btn-sm" onClick={onCloseTab}>
                  {t('terminal.closeTab')}
                </button>
              )}
            </div>
          </div>
        )}
        {disconnected && !windowMissing && !paneUnavailable && (
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
        {dbWindow?.sleeping && (
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
              {t('terminal.sleeping')}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => handleRespawn()}
                disabled={respawning}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {respawning && (
                  <span
                    role="status"
                    aria-label="Waking"
                    style={{
                      display: 'inline-block',
                      width: 12,
                      height: 12,
                      border: '2px solid rgba(255,255,255,0.3)',
                      borderTopColor: '#fff',
                      borderRadius: '50%',
                      animation: 'spin 0.6s linear infinite',
                    }}
                  />
                )}
                {respawning ? t('terminal.respawning') : t('terminal.wake')}
              </button>
              {onCloseTab && (
                <button className="btn btn-sm" onClick={onCloseTab}>
                  {t('terminal.closeTab')}
                </button>
              )}
            </div>
          </div>
        )}
        {windowMissing && !dbWindow?.sleeping && (
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
