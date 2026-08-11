import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useNotificationChannel } from '../../hooks/useNotificationChannel';
import { useWindowActions } from '../../hooks/useWindowActions';
import { StatusDot } from '../StatusBadge';
import { MiniTabBar, IconButton, Button, PanelHeader, Spinner, WindowActivityIndicator } from '../ui';
import type { MiniTab } from '../ui';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import TaskRefBadges from '../TaskRefBadges';
import TaskLogView from '../TaskLogView';
import MarkdownRenderer, { mdStyles } from '../MarkdownRenderer';
import { TerminalContainer, viewModeStorageKey, type WindowViewMode } from '../TerminalContainer';
import { DiffViewer, CommitList } from '../diff';
import { Chip } from '../ui';
import { resolveTmuxWindow } from '../../lib/tmuxPane';
import ContextMenu, { useContextMenu, type ContextMenuItem } from '../ContextMenu';
import ResourceWarningDialog from '../ResourceWarningDialog';
import PhaseProgressBar from './PhaseProgressBar';
import StatusDropdown from '../task/StatusDropdown';
import TaskDetailMenu from './TaskDetailMenu';
import TaskGitTab from '../task/TaskGitTab';
import { useUnitTypes, findUnitType } from '../../hooks/useUnitTypes';
import { Icon } from '../ui/Icon';
import TaskSummaryTab from '../task/TaskSummaryTab';
import TaskUnitSetupForm from '../task/TaskUnitSetupForm';
import TaskWindowDropdown from '../task/TaskWindowDropdown';
import { usePaneLayout } from '../../hooks/usePaneLayout';
import { usePaneRects } from '../../hooks/usePaneRects';
import { findPane, findPaneByTab, listPanes, type PaneNode, type DropZone } from '../../hooks/paneLayoutTree';
import { SplitLayout, type PaneDrag } from './SplitLayout';
import { computeTabOverlayStyle } from './paneTabOverlay';
import BrowserView from '../BrowserView';
import { useBrowserKeepalive, type BrowserGroupRef } from '../../hooks/useBrowserKeepalive';
import { closeBrowserGroup } from '../../lib/browserGroup';
import type { Task, Unit, Window, Session, Project, ExecutionApprovalData } from '../../pages/workspace/types';
import type { PersistedTab } from '../../hooks/useTabPersistence';
import { useIsMobile } from '../../hooks/useIsMobile';
import { isSameWindowTarget } from '../../utils/tmuxTarget';
import { activityKey, useWorkspaceTargets } from '../../hooks/useWorkspaceTargets';
import { useGlobalFocus } from '../../hooks/useGlobalFocus';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import {
  SUB_TAB_KEY, viewTabId, parseViewTabId, windowTabId, parseWindowTabId,
  browserTabId, parseBrowserTabId, listPersistedBrowserTabIds,
  makeTaskLayoutStorage, hasPersistedTaskLayout, SELECT_BROWSER_EVENT, SELECT_TERMINAL_EVENT, resolveWindowContextExtra,
  resolveDisplayedTaskTerminal, selectTaskTerminal,
  type FixedView, type TerminalRef,
} from '../task/taskPaneLayout';
import { ApprovalRequestTracker, isApprovalDataForTask } from '../task/executionApprovalRequest';
import { TerminalChatToggle, type WindowViewMode as TerminalChatViewMode } from '../ui/TerminalChatToggle';
import { claimFooterHeight, releaseFooterHeight } from '../../lib/spFooterHeight';

// Re-exported so existing external imports (`from './TaskPanel'`) keep working —
// the actual implementation lives in taskPaneLayout.ts, alongside the rest of the
// task-scoped tab model, so it can be unit-tested independently of TaskPanel's render tree.
export { resolveDisplayedTaskTerminal, selectTaskTerminal };

interface TaskPanelProps {
  taskId: number;
  /** Whether this panel's tab is the currently active/visible one. Defaults to true for
   * callers that don't track tab visibility. When false, background refetches (WS events,
   * polling) are suppressed to avoid one request per hidden task tab. */
  isVisible?: boolean;
  /**
   * Whether this panel's pane is the *focused* one (relevant only when multiple task
   * tabs can be visible at once, i.e. Workspace's desktop multi-pane split — Issue
   * #397). Defaults to true for callers that don't track pane focus (mobile's single-
   * view path, or any other single-pane consumer). When false, this panel must not
   * write to the global focus singleton (`useGlobalFocus`'s `setFocus`) even while
   * `isVisible` — otherwise a background windows-poll in a *visible but unfocused*
   * pane would steal focus from whichever pane the user actually has focused, sending
   * mobile key-send / sidebar highlighting to the wrong terminal.
   */
  isPaneFocused?: boolean;
  allUnits: Unit[];
  tasks: Task[];
  allTasks: Task[];
  projects: { id: number; name: string }[];
  /** The workspace's current project (for pre-selecting/hinting its default Unit). Only used when it matches the task's project. */
  currentProject?: Project | null;
  sessionData: Record<string, Session[]>;
  executeTask: (taskId: number, unitId: number | null) => void;
  stopTask: (unitId: number | null) => void;
  onRefresh: () => void;
  onBack?: () => void;
  onDelete?: (taskId: number) => void;
  onEdit?: (taskId: number) => void;
  onOpenAddWindow?: (forTask?: boolean, taskProjectId?: number, taskId?: number) => void;
  onSplitPane?: (serverName: string, target: string, direction: 'h' | 'v') => void;
  onOpenTask?: (taskId: number, title: string) => void;
  tabs?: PersistedTab[];
  closeTab?: (tabId: string) => void;
  /** SP ⋯ フルサイズメニュー（Issue #69 S8）の「タブ操作 › ピン止め」から呼ぶ。省略時はメニュー
   * にピン止め行を出さない代わりにトグル自体を無効化する（呼び出し元が useTabPersistence 経由で
   * 渡さない限り常に有効 — Workspace.tsx が TabContentRenderer を通じて配線する）。 */
  togglePin?: (tabId: string) => void;
  /**
   * Servers of the *current* project (Workspace's `data.projectServers`), used only as the
   * last-resort fallback for resolving which server a brand-new ＋ menu "ブラウザ" tab should
   * connect to (see `browserServerName` below). Only trusted when it actually is the task's
   * own project — same cross-project guard `projectDefaultUnitId` already uses, since a task
   * opened cross-project (see CLAUDE.md "Cross-project task lookup") must not resolve a
   * browser onto some other project's server.
   */
  projectServers?: { serverName: string }[];
  /** Diff ビューの ✎「エディターで開く」導線。作業ディレクトリ基準の相対パスを file タブとして開く。 */
  onOpenFile?: (serverName: string, filePath: string) => void;
  /**
   * Notifies the caller once a task-scoped browser tab's page has actually been created
   * server-side, so the sidebar's "ブラウザ" section (server-wide, not task-scoped) can
   * refetch immediately instead of waiting for its next poll. Mirrors the same prop on
   * the workspace-level browser tab (TabContentRenderer's `BrowserView`).
   */
  onBrowserPageReady?: () => void;
}

// SP 概要セグメントに併合した旧 Unit/Git/サマリータブの区切り（Issue #69 T5）。単なる見出し
// ＋薄い上罫線のみ — 新規のアニメーション/トークンは追加せず既存の --border/--text-dim を使う。
function MobileOverviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div style={{
        fontSize: 'var(--font-2xs)', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: 0.5, color: 'var(--text-dim)', marginBottom: 8,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// SP コンテンツヘッダー（承認済み S8: チップ行→タイトル行→コンテンツヘッダー(36px)→コンテンツ→
// 下部文脈バー）— 端末/チャット以外（説明・Unit・実行情報・コミット履歴・差分）のフルスクリーン
// ビュー用。端末/チャットは TerminalContainer 自身のツールバー（leading/trailing、Issue #69 S8）
// がこの役目を果たすため別実装 — ここでは「タイトルのみ」「タイトル＋右端アクション」の2形しか
// 要らない軽量な内蔵ヘッダーとして持つ（他画面と共有する見込みが薄いため base component へは
// 抽出しない）。
function MobileContentHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      minHeight: 36, padding: '0 16px', background: 'var(--bg-card)',
      borderBottom: '1px solid var(--border)', flexShrink: 0,
    }}>
      <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </span>
      {action}
    </div>
  );
}

// SP 下部文脈バー（端末/チャット以外を表示中のとき、Issue #69 S8）: 端末/チャットビューでは
// qbar（TerminalQuickKeyBar）/PromptInputBar 自身が端末⇄チャットのミニトグルを描く（下端固定
// バーは既にそこにある）。それ以外のビュー（説明・Unit・実行情報・コミット履歴・差分）表示中は
// 下端に何も無くなってしまうため、「情報ビュー表示中も下部トグル操作で端末/チャットに復帰できる」
// 仕様を満たす最小限のバー（トグルのみ）をここで描く。qbar/PromptInputBar と同じ
// --sp-footer-h claim/release オーナー方式に参加する（F2稼働ステータスピルのオフセット計算対象）。
const CONTEXT_FOOTER_OWNER = 'task-panel-context-footer';

function MobileContextFooter({ value, onChange, disabled }: { value: TerminalChatViewMode; onChange: (mode: TerminalChatViewMode) => void; disabled: boolean }) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      claimFooterHeight(CONTEXT_FOOTER_OWNER, el.getBoundingClientRect().height);
    });
    observer.observe(el);
    claimFooterHeight(CONTEXT_FOOTER_OWNER, el.getBoundingClientRect().height);
    return () => {
      observer.disconnect();
      releaseFooterHeight(CONTEXT_FOOTER_OWNER);
    };
  }, []);
  return (
    <div
      ref={barRef}
      style={{
        display: 'flex', alignItems: 'center', flexShrink: 0,
        padding: 'var(--space-2)', paddingBottom: 'calc(var(--space-2) + env(safe-area-inset-bottom))',
        background: 'var(--bg-card)',
      }}
    >
      <TerminalChatToggle value={value} onChange={onChange} disabled={disabled} />
    </div>
  );
}

export default function TaskPanel({
  taskId, isVisible = true, isPaneFocused = true, allUnits, tasks, allTasks, projects, currentProject, sessionData,
  executeTask, stopTask, onRefresh, onBack, onDelete, onEdit, onOpenAddWindow,
  onSplitPane, onOpenTask, tabs, closeTab, togglePin, projectServers, onOpenFile, onBrowserPageReady,
}: TaskPanelProps) {
  const { t } = useTranslation(['tasks', 'workspace', 'common']);
  // The list response omits the detail-only documents (description, plan, summary,
  // changed files) — they made the payload unusable on mobile networks. `fetchTaskData`
  // below already pulls the full record from `/tasks/:id`; merge it over the list item
  // so every tab reads one object regardless of where each field came from.
  const taskListItem = tasks.find((t) => t.id === taskId) ?? allTasks.find((t) => t.id === taskId);
  const [taskDetail, setTaskDetail] = useState<Task | null>(null);
  const detailLoaded = taskDetail !== null && taskDetail.id === taskId;
  const task = detailLoaded ? { ...taskListItem, ...taskDetail } as Task : taskListItem;
  const { unitTypes } = useUnitTypes();
  const [submittingAnswers, setSubmittingAnswers] = useState(false);
  // Execution-approval gate (Issue #51): fetched on demand only while the
  // task is actually pending_approval — see the fetch effect below, which
  // keys off `task?.status` so re-approval after an edit (server clears the
  // fingerprint, status goes back to pending_approval) triggers a fresh
  // fetch rather than showing stale content from a previous approval round.
  const [approvalData, setApprovalData] = useState<ExecutionApprovalData | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [submittingApproval, setSubmittingApproval] = useState<'approve' | 'deny' | null>(null);
  const [windows, setWindows] = useState<Window[]>([]);
  // Tracks whether this task's windows have been *successfully* fetched at least once
  // since the panel last switched to this taskId. `allTabIds` starts out windowless
  // (`windows === []`) on every task switch, so the pane layout's allTabIds-sync
  // reconcile must not run until this flips true — otherwise it would prune every
  // persisted window tab before the first `/tasks/:id` fetch ever resolves (see the
  // `ready` option passed to usePaneLayout below). A failed fetch intentionally leaves
  // this false — flipping it on failure would let reconcile run against the still-empty
  // `windows` and destroy the persisted layout instead of protecting it; retries (60s
  // interval / notification-triggered refetches) are what eventually flip it.
  const [windowsReady, setWindowsReady] = useState(false);

  const [diffActiveFile, setDiffActiveFile] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);

  const hasUnit = !!(task?.unitId);
  const unit = task ? allUnits.find((u) => u.id === task.unitId) : undefined;
  const proj = task ? projects.find((p) => p.id === task.projectId) : undefined;
  // Only trust currentProject's defaultUnitId when it actually is the task's project
  // (TaskPanel can show a task opened cross-project; see CLAUDE.md "Cross-project task lookup").
  const projectDefaultUnitId = task && currentProject && currentProject.id === task.projectId
    ? currentProject.defaultUnitId ?? null
    : null;

  const diffPath = task ? (task.worktreePath || task.workingDirectory) : null;
  const diffServerName = (windows.find((w) => w.isPrimary) || windows[windows.length - 1])?.serverName || task?.serverName || undefined;
  const handleOpenDiffFile = onOpenFile && diffPath && diffServerName
    ? (relPath: string) => {
        const base = diffPath.endsWith('/') ? diffPath : diffPath + '/';
        onOpenFile(diffServerName, base + relPath);
      }
    : undefined;
  // Server a brand-new ＋ menu "ブラウザ" tab connects to: primary window's serverName →
  // task.serverName (same two steps as diffServerName above) → the current project's first
  // server, guarded the same way projectDefaultUnitId is (only trusted when currentProject
  // actually is the task's own project). Undefined when none of these resolve — the ＋ menu's
  // "ブラウザ" item is disabled in that case rather than falling back to a wrong server.
  const browserServerName = diffServerName
    ?? (task && currentProject && currentProject.id === task.projectId ? projectServers?.[0]?.serverName : undefined);

  // Task-scoped CDP browser tab instances (feature addition alongside Issue #397's window
  // tabs) — ephemeral/user-created via the ＋ menu, never server-driven. Seeded once at mount
  // (and on taskId change) from whatever `v-browser:` tab ids the persisted layout for this
  // task already contains, so a reload restores them (see listPersistedBrowserTabIds's doc:
  // this must happen before allTabIds/reconcile ever runs, or a restored browser tab gets
  // pruned immediately as "not in allTabIds").
  const [browserTabIds, setBrowserTabIds] = useState<string[]>(() => listPersistedBrowserTabIds(taskId));
  useEffect(() => {
    setBrowserTabIds(listPersistedBrowserTabIds(taskId));
  }, [taskId]);

  // Views selectable for this task, and the task-scoped multi-pane layout tree over
  // them + the task's assigned windows (Issue #397 step 5). `allTabIds` must stay a
  // stable reference across renders that don't actually add/remove tabs, or
  // usePaneLayout's reconcile effect (a no-op on an unchanged tab set) would still
  // fire pointlessly every render — hence keying the memo on joined strings.
  const availableFixedViews = useMemo((): FixedView[] => [
    'description', 'unit',
    ...(hasUnit ? (['git', 'summary'] as const) : []),
    ...(hasUnit && diffPath && diffServerName ? (['commits', 'diff'] as const) : []),
  ], [hasUnit, diffPath, diffServerName]);
  const windowTabIdsList = useMemo(() => windows.map((w) => windowTabId(w.serverName, w.tmuxTarget)), [windows]);
  const availableFixedViewsKey = availableFixedViews.join(',');
  const windowTabIdsKey = windowTabIdsList.join(',');
  const browserTabIdsKey = browserTabIds.join(',');
  const allTabIds = useMemo(
    () => [...availableFixedViews.map(viewTabId), ...windowTabIdsList, ...browserTabIds],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [availableFixedViewsKey, windowTabIdsKey, browserTabIdsKey],
  );
  const initialTabIds = useMemo(() => [viewTabId('description')], []);

  // Keepalive for every `v-browser:` tab currently in *this task's* layout tree —
  // independent of whether any given one is actually mounted (its pane's active tab) right
  // now, and independent of whether this whole task tab is visible: as long as TaskPanel
  // itself is mounted (a task tab, once opened, stays mounted while hidden — see
  // TabContentRenderer), every browser instance the user has opened for this task keeps
  // getting kept alive, the same way Workspace-level browser tabs do regardless of which
  // workspace tab is currently active.
  const browserKeepaliveGroups = useMemo(
    () => browserTabIds.map(parseBrowserTabId).filter((g): g is BrowserGroupRef => !!g),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [browserTabIdsKey],
  );
  useBrowserKeepalive(browserKeepaliveGroups);

  // `defaultViewTabIds` seeds a brand-new task's very first layout (see
  // buildDefaultTaskLayout) — recreated whenever the available fixed views
  // change so a load() right after that change sees the current set, even
  // though load() itself only actually runs at mount/task-switch time.
  const defaultViewTabIds = useMemo(() => availableFixedViews.map(viewTabId), [availableFixedViewsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const taskLayoutStorage = useMemo(() => makeTaskLayoutStorage(taskId, defaultViewTabIds), [taskId, defaultViewTabIds]);
  // Snapshot of "did this task already have a persisted layout" taken during render, at the
  // same moment `usePaneLayout` below first loads (mount / taskId change) — i.e. *before*
  // usePaneLayout's own persist effect has a chance to write the just-loaded default state
  // back to storage (that effect fires on every `keyed` change including the mount commit,
  // so reading `hasPersistedTaskLayout` from inside a later passive effect would already see
  // that write and always report "persisted", even for a task that was genuinely never opened
  // before). `useMemo` runs synchronously during render, so it captures the pre-mount value.
  const taskHadPersistedLayout = useMemo(() => hasPersistedTaskLayout(taskId), [taskId]);
  // Task-scoped allTabIds means "tabs available to open", not "tabs the user has
  // open" (unlike Workspace's workspace-layout) — appendMissing: false so a tab
  // the user explicitly closed via × stays closed instead of reappearing the next
  // time allTabIds changes reference (e.g. the windows-list 30s poll).
  const layout = usePaneLayout(`${SUB_TAB_KEY}:${taskId}`, allTabIds, initialTabIds, taskLayoutStorage, { appendMissing: false, ready: windowsReady });
  const paneRects = usePaneRects();
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);

  const { menu: ctxMenu, show: showCtxMenu, showAt: showCtxMenuAt, hide: hideCtxMenu } = useContextMenu();
  const moreMenu = useContextMenu();
  const isMobile = useIsMobile();
  // SP ⋯ フルサイズメニュー（TaskDetailMenu、Issue #69 S8）— デスクトップの ⋯ は従来どおり
  // moreMenu（ContextMenu）を使う。own タブ id は useTabPersistence.openTask と同じ形式
  // （`task:${taskId}`）— ピン状態/タブを閉じる操作の対象を特定するために使う。
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const ownTabId = `task:${taskId}`;
  const isPinned = !!tabs?.find((tb) => tb.id === ownTabId)?.pinned;
  // Restored window-list dropdown (the pre-#397 TaskWindowDropdown) — at most one open at a
  // time, keyed by the pane whose trailing trigger opened it, since opening a window from
  // it targets that specific pane.
  const [windowDropdownPaneId, setWindowDropdownPaneId] = useState<string | null>(null);
  // Working/blocked/finished activity indicator for window tabs — the same source
  // WindowsSidebar/the old TaskWindowDropdown/TaskWindowListView used, so a window tab
  // shows the same per-window activity state as every other window surface.
  const { windowIndicator, finishedEntries } = useAgentActivity();

  // SP 差し戻し（オーケストレーター照合、Issue #69）: タスク詳細の初期表示は「説明」ではなく
  // ウィンドウコンテンツ（端末/チャット）が既定。一度もレイアウトが永続化されていない
  // 真に新規のタスク表示のときだけ、ウィンドウが1件以上あれば先頭のウィンドウタブへ
  // 切り替える（保存済みレイアウトが既に持つ明示的なアクティブタブはそのまま尊重し、
  // ここでは上書きしない）。ウィンドウ0件のタスクは「説明」フォールバックのまま。
  // デスクトップの初期タブ挙動は不変（このガードは isMobile 限定）。taskId ごとに一度だけ
  // 判定するので、以後ユーザーが「説明」へ手動で戻ってもここで巻き戻されない。
  const appliedMobileDefaultTaskIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!isMobile || !windowsReady) return;
    if (appliedMobileDefaultTaskIdRef.current === taskId) return;
    appliedMobileDefaultTaskIdRef.current = taskId;
    if (taskHadPersistedLayout) return;
    if (windowTabIdsList.length === 0) return;
    const pane = layout.state.focusedPaneId ? findPane(layout.state.root, layout.state.focusedPaneId) : null;
    if (!pane || pane.activeTabId !== viewTabId('description')) return;
    layout.open(windowTabIdsList[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile, windowsReady, taskId, windowTabIdsList, taskHadPersistedLayout]);

  const findTaskByTarget = useCallback((target: string) =>
    allTasks.find((t) => t.windows?.some((w) => w.tmuxTarget === target)) ?? null,
  [allTasks]);

  const [reconnectKeys, setReconnectKeys] = useState<Record<string, number>>({});

  // Defined here (rather than alongside the other view handlers below) so it can be
  // passed into useWindowActions as connectPane — respawn needs it to switch this
  // panel's displayed window tab to the respawned window.
  const handlePaneClick = useCallback((serverName: string, target: string, _projectId?: number, opts?: { reconnect?: boolean }) => {
    const tabId = windowTabId(serverName, target);
    if (opts?.reconnect) {
      setReconnectKeys((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    }
    layout.open(tabId);
  }, [layout]);

  const windowActions = useWindowActions(
    proj ? String(proj.id) : undefined,
    onRefresh,
    {
      showContextMenu: showCtxMenu,
      showContextMenuAt: showCtxMenuAt,
      findTaskByTarget,
      openTask: onOpenTask ?? (() => {}),
      tabs: tabs ?? [],
      closeTab: closeTab ?? (() => {}),
      connectPane: handlePaneClick,
    },
  );

  // Tracks the taskId currently shown so in-flight /tasks/:id responses for a previous
  // task are discarded (otherwise its windows could briefly replace the new task's and
  // trigger a wrong primary-pane fallback that overwrites the persisted terminal).
  const currentTaskIdRef = useRef(taskId);
  currentTaskIdRef.current = taskId;

  // Latest isVisible, read inside handlers/interval callbacks so subscriptions don't need
  // to be re-created on every visibility flip (churn).
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const fetchTaskData = useCallback(async () => {
    if (!taskId) return;
    try {
      const res = await api<Task & { windows?: Window[] }>(`/tasks/${taskId}`);
      if (currentTaskIdRef.current !== taskId) return; // stale response for a previous task
      setTaskDetail(res);
      if (res.windows) setWindows(res.windows);
      setWindowsReady(true);
    } catch {
      // Do NOT mark windows as "ready" on failure: `windows` is still `[]` at this
      // point, so flipping ready would let the allTabIds-sync reconcile run against
      // a windowless tab set and prune every persisted window tab (appendMissing:
      // false means nothing then restores them). Leave ready false and let it stay
      // false — the 60s interval / notification-triggered refetches will retry, and
      // ready only flips once one of them actually succeeds, protecting the
      // persisted layout until we truly know the current windows.
    }
  }, [taskId]);

  useNotificationChannel({
    onTaskStatus: useCallback(({ taskId: id }: { taskId: number }) => {
      if (!isVisibleRef.current) return;
      if (id === taskId) fetchTaskData();
    }, [taskId, fetchTaskData]),
    onSessionsUpdated: useCallback(() => {
      if (!isVisibleRef.current) return;
      fetchTaskData();
    }, [fetchTaskData]),
  });

  useEffect(() => {
    setWindows([]);
    setWindowsReady(false);
    setTaskDetail(null);
    if (!taskId) return;
    fetchTaskData();
    const interval = setInterval(() => {
      if (!isVisibleRef.current) return;
      fetchTaskData();
    }, 60000);
    return () => clearInterval(interval);
  }, [taskId, fetchTaskData]);

  // When the tab becomes visible again after being hidden, refresh once immediately
  // (background refetches were suppressed above while hidden).
  const prevIsVisibleRef = useRef(isVisible);
  useEffect(() => {
    if (isVisible && !prevIsVisibleRef.current) fetchTaskData();
    prevIsVisibleRef.current = isVisible;
  }, [isVisible, fetchTaskData]);

  // Apply an external terminal selection (selectTaskTerminal) while already mounted —
  // the layout's own storage reload only runs on taskId/storageKey change, so a mounted
  // panel for the same task needs this live notification to switch its displayed tab.
  useEffect(() => {
    const terminalHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId: number; tabId: string }>).detail;
      if (!detail || detail.taskId !== taskId) return;
      layout.open(detail.tabId);
    };
    const browserHandler = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId: number; tabId: string }>).detail;
      if (!detail || detail.taskId !== taskId) return;
      setBrowserTabIds((prev) => prev.includes(detail.tabId) ? prev : [...prev, detail.tabId]);
      layout.open(detail.tabId);
    };
    window.addEventListener(SELECT_TERMINAL_EVENT, terminalHandler);
    window.addEventListener(SELECT_BROWSER_EVENT, browserHandler);
    return () => {
      window.removeEventListener(SELECT_TERMINAL_EVENT, terminalHandler);
      window.removeEventListener(SELECT_BROWSER_EVENT, browserHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, layout.open]);

  // Window tab ids encode the pane-suffix-stripped target (see windowTabId's doc comment),
  // while every actual consumer (terminal connect, visible-target/focus registration for
  // isWatched()/send-keys) needs the window's real `tmuxTarget` (which does carry a pane
  // suffix) — resolve it from `windows` via isSameWindowTarget, the same match
  // resolveWindowContextExtra/buildMiniTab use. Falls back to the encoded (stripped)
  // target when the window isn't found (e.g. briefly, before the first windows fetch).
  const resolveWindowTabTarget = useCallback((win: TerminalRef): TerminalRef => {
    const w = windows.find((x) => x.serverName === win.serverName && isSameWindowTarget(x.tmuxTarget, win.target));
    return w ? { serverName: w.serverName, target: w.tmuxTarget } : win;
  }, [windows]);

  const { setFocusedTarget } = useWorkspaceTargets();

  // Push the terminal currently displayed by this task panel's *focused* pane into
  // global focus, so the WindowsSidebar highlight follows in-task window switches
  // without requiring a tab switch. Only the active tab's panel should do this — an
  // inactive task tab must not steal focus from whatever is actually visible. `setFocus`
  // is a single global slot, so with multiple task tabs visible at once (Workspace's
  // desktop multi-pane split), a panel must additionally only write when its own pane
  // is the *focused* one (`isPaneFocused`) — otherwise a visible-but-unfocused pane's
  // background windows poll would re-run this effect and steal focus from whichever
  // pane the user actually has focused (see the `isPaneFocused` prop doc for detail).
  const focusedWindowTarget = useMemo(() => {
    const pane = layout.state.focusedPaneId ? findPane(layout.state.root, layout.state.focusedPaneId) : null;
    const activeTabId = pane?.activeTabId ?? null;
    const parsed = activeTabId ? parseWindowTabId(activeTabId) : null;
    return parsed ? resolveWindowTabTarget(parsed) : null;
  }, [layout.state.root, layout.state.focusedPaneId, resolveWindowTabTarget]);

  // The focused pane's window record — shared by the SP window bar's live pane count
  // ("▣ win ▾ Nペイン") and the SP terminal/chat view-mode persistence below (both keyed
  // by the actual `windows` row id, Issue #69 T5).
  const focusedWindow = useMemo(() => {
    if (!focusedWindowTarget) return undefined;
    return windows.find((w) => w.serverName === focusedWindowTarget.serverName && isSameWindowTarget(w.tmuxTarget, focusedWindowTarget.target));
  }, [focusedWindowTarget, windows]);
  const focusedWindowId = focusedWindow?.id ?? null;

  // SP ウィンドウバー右端の「Nペイン」— tmux 上のライブなペイン数（Window レコードの静的な
  // paneLayout ではなく、実際に今開いているペイン数を見せる）。
  const displayedWindowPaneCount = useMemo(() => {
    if (!focusedWindowTarget) return null;
    const sessions = sessionData[focusedWindowTarget.serverName];
    if (!sessions) return null;
    const tw = resolveTmuxWindow(sessions, focusedWindowTarget.target);
    return tw ? tw.panes.length : null;
  }, [focusedWindowTarget, sessionData]);

  // SP 端末/チャットセグメント（Issue #69 T5）: 表示モードは TaskPanel が単一の真実源として
  // localStorage（azito.windowView.<windowId>、TerminalContainer と同一キー形式を共有）を
  // 読み書きし、TerminalContainer には確定値を viewMode prop で渡す（controlled）。ウィンドウが
  // 切り替わるたびそのウィンドウの最後の選択を読み直す — 旧 TerminalContainer 内蔵ロジックと
  // 同じ「ウィンドウ単位で記憶する」粒度を維持する。
  const [mobileViewMode, setMobileViewModeState] = useState<WindowViewMode>('terminal');
  useEffect(() => {
    if (focusedWindowId === null) return;
    const stored = localStorage.getItem(viewModeStorageKey(focusedWindowId));
    setMobileViewModeState(stored === 'chat' ? 'chat' : 'terminal');
  }, [focusedWindowId]);
  const setMobileViewMode = useCallback((mode: WindowViewMode, windowId: number | null) => {
    setMobileViewModeState(mode);
    if (windowId !== null) localStorage.setItem(viewModeStorageKey(windowId), mode);
  }, []);

  const { setFocus } = useGlobalFocus();
  const { showToast } = useToast();
  const confirm = useConfirm();
  useEffect(() => {
    if (!isVisible || !isPaneFocused) return;
    const displayed = focusedWindowTarget ?? resolveDisplayedTaskTerminal(taskId, windows);
    setFocus({ serverName: displayed?.serverName ?? null, tmuxTarget: displayed?.target ?? null, taskId });
  }, [isVisible, isPaneFocused, focusedWindowTarget, windows, taskId, setFocus]);

  useEffect(() => {
    if (!isVisible || !isPaneFocused) return;
    const target = focusedWindowTarget ?? resolveDisplayedTaskTerminal(taskId, windows);
    if (target) {
      setFocusedTarget(activityKey(target.serverName, target.target));
    }
    return () => setFocusedTarget(null);
  }, [isVisible, isPaneFocused, focusedWindowTarget, windows, taskId, setFocusedTarget]);

  const handleDelete = useCallback(async () => {
    const ok = await confirm({ title: t('actions.deleteTask'), message: t('actions.deleteConfirm'), danger: true });
    if (!ok) return;
    await api(`/tasks/${taskId}`, { method: 'DELETE' });
    if (onDelete) onDelete(taskId);
    onRefresh();
  }, [taskId, onDelete, onRefresh, confirm]);

  const handleArchive = useCallback(async () => {
    const ok = await confirm({ title: t('actions.archiveTask'), message: t('actions.archiveConfirm'), danger: true });
    if (!ok) return;
    await api(`/tasks/${taskId}/archive`, { method: 'POST' });
    onRefresh();
    fetchTaskData();
  }, [taskId, onRefresh, fetchTaskData, confirm]);

  const handleRestore = useCallback(async () => {
    await api(`/tasks/${taskId}/restore`, { method: 'POST' });
    onRefresh();
    fetchTaskData();
  }, [taskId, onRefresh, fetchTaskData]);

  // Cancels a stale in-flight GET when a newer one supersedes it (task
  // switched, or the same task's approval was re-fetched after a 409
  // fingerprint-mismatch) — see fetchApprovalData below. `approvalTracker`'s
  // generation guard is invalidated (with no new controller) whenever the
  // task stops being pending_approval, so a response already in flight at
  // that moment cannot land after the fact. See executionApprovalRequest.ts
  // for why this is a plain (non-React) class — it lets the exact guard
  // logic be unit tested without mounting TaskPanel's render tree.
  const approvalAbortRef = useRef<AbortController | null>(null);
  const approvalTrackerRef = useRef<ApprovalRequestTracker | null>(null);
  if (approvalTrackerRef.current === null) approvalTrackerRef.current = new ApprovalRequestTracker();
  const approvalTracker = approvalTrackerRef.current;

  // Shared by the fetch-on-open effect below AND by handleExecutionApproval's
  // 409 fingerprint-mismatch handling (Issue #328 review fix 1): a stale
  // approval is refused, and this same fetch is what re-presents the human
  // with what actually changed instead of silently resubmitting against it.
  //
  // Cancellation + generation guard (Issue #328 review — TaskPanel approval
  // race): switching between two `pending_approval` tasks in quick
  // succession used to let whichever GET happened to resolve LAST win,
  // regardless of which task was actually being requested first — so
  // `approvalData` (and therefore the taskId the Approve/Deny buttons submit
  // against) could end up holding a DIFFERENT task than the one on screen.
  // `approvalAbortRef` additionally cancels the previous request's
  // underlying fetch so it doesn't do pointless work.
  const fetchApprovalData = useCallback(async (id: number) => {
    approvalAbortRef.current?.abort();
    const controller = new AbortController();
    approvalAbortRef.current = controller;
    const requestId = approvalTracker.begin();
    // Clear immediately — never leave a PREVIOUS task's approval content (and
    // its taskId/fingerprint) on screen, submittable, while a new task's
    // fetch is in flight.
    setApprovalData(null);
    setApprovalLoading(true);
    setApprovalError(null);
    try {
      const res = await api<ExecutionApprovalData & { error?: string }>(`/tasks/${id}/execution-approval`, { signal: controller.signal });
      if (!approvalTracker.isCurrent(requestId)) return; // superseded
      if (res.error) {
        setApprovalError(res.error);
        setApprovalData(null);
      } else {
        setApprovalData(res);
      }
    } catch {
      if (controller.signal.aborted) return; // superseded — a newer request already owns the UI
      if (!approvalTracker.isCurrent(requestId)) return;
      setApprovalError(t('executionApproval.loadError'));
    } finally {
      if (approvalTracker.isCurrent(requestId)) setApprovalLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!task || task.status !== 'pending_approval') {
      approvalAbortRef.current?.abort();
      approvalTracker.invalidate(); // invalidate any request still in flight
      setApprovalData(null);
      setApprovalError(null);
      return;
    }
    fetchApprovalData(task.id);
    // fetchApprovalData is intentionally omitted: it's stable in practice
    // (only depends on `t`), and including it would re-fetch on every
    // locale-driven re-render instead of only when the task/status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.status]);

  const handleExecutionApproval = useCallback(async (approved: boolean) => {
    if (!approvalData || submittingApproval) return;
    // Defense in depth alongside the generation guard in fetchApprovalData
    // above: never submit an approval decision against a task other than
    // the one currently displayed (Issue #328 review — approving the wrong
    // task is a human-judgment integrity issue, not just a display glitch).
    if (!isApprovalDataForTask(approvalData, taskId)) {
      showToast(t('executionApproval.loadError'));
      return;
    }
    setSubmittingApproval(approved ? 'approve' : 'deny');
    try {
      const res = await api<{ error?: string; code?: string }>(`/tasks/${approvalData.taskId}/approve-execution`, {
        method: 'POST',
        // origin: 'approval_panel' (task/328 follow-up, part B) — audit-only,
        // marks this decision as made through the pending_approval panel
        // (as opposed to the create-form's own auto pre-approval flow), so
        // the two are distinguishable in the execution log later.
        body: JSON.stringify(approved ? { approved, fingerprint: approvalData.fingerprint, origin: 'approval_panel' } : { approved, origin: 'approval_panel' }),
      });
      if (res.error) {
        if (res.code === 'fingerprint_mismatch') {
          // Do NOT resubmit — the content the human approved is not the
          // content that would actually run. Refetch and show them the
          // current state instead (Issue #328 review fix 1).
          showToast(t('executionApproval.contentChanged'));
          await fetchApprovalData(approvalData.taskId);
        } else {
          showToast(res.error);
        }
        return;
      }
      onRefresh();
      fetchTaskData();
    } finally {
      setSubmittingApproval(null);
    }
  }, [approvalData, submittingApproval, taskId, showToast, onRefresh, fetchTaskData, fetchApprovalData, t]);

  const handlePlanAction = useCallback(async (planTask: Task, approved: boolean) => {
    if (!planTask.unitId) return;
    const el = document.querySelector('[data-plan-feedback]') as HTMLTextAreaElement | null;
    const feedback = el?.value.trim() || undefined;
    if (!approved && !feedback) {
      const res = await api<{ error?: string }>(`/units/${planTask.unitId}/approve-plan`, {
        method: 'POST',
        body: JSON.stringify({ taskId: planTask.id, approved: false }),
      });
      if (res.error) return showToast(res.error);
    } else {
      const res = await api<{ error?: string }>(`/units/${planTask.unitId}/approve-plan`, {
        method: 'POST',
        body: JSON.stringify({ taskId: planTask.id, approved, feedback }),
      });
      if (res.error) return showToast(res.error);
    }
    if (el) el.value = '';
    onRefresh();
  }, [onRefresh, showToast]);

  const handleStatusChange = useCallback(async (newStatus: string) => {
    try {
      await api(`/tasks/${taskId}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
      onRefresh();
    } catch (err) {
      console.error('Status change failed:', err);
    }
  }, [taskId, onRefresh]);

  const handleSwitchToDiff = useCallback((file?: string) => {
    layout.open(viewTabId('diff'));
    setDiffActiveFile(file || null);
  }, [layout]);

  const handleAssignAndExecute = useCallback(async (
    unitId: number,
    settings: { branchName?: string; skipPr?: boolean; workingDirectory?: string },
  ) => {
    if (!task) return;
    await api(`/tasks/${task.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        unit_id: unitId,
        branch: settings.branchName || undefined,
        skip_pr: settings.skipPr || false,
        working_directory: settings.workingDirectory || undefined,
      }),
    });
    onRefresh();
    executeTask(task.id, unitId);
  }, [task, onRefresh, executeTask]);

  // --- Task-scoped pane layout wiring (Issue #397 step 5) ------------------

  const buildMiniTab = useCallback((tabId: string): MiniTab => {
    const viewName = parseViewTabId(tabId);
    if (viewName) return { key: tabId, label: t(`workspace:viewLabels.${viewName}`), closable: viewName !== 'description' };
    const win = parseWindowTabId(tabId);
    if (win) {
      const w = windows.find((x) => x.serverName === win.serverName && isSameWindowTarget(x.tmuxTarget, win.target));
      // Per-window working/blocked/finished state (WindowsSidebar/the old
      // TaskWindowDropdown/TaskWindowListView all read the same useAgentActivity source) —
      // respawning takes priority since the window is temporarily unreachable either way.
      const isRespawning = w ? windowActions.respawningWindowIds.has(w.id) : false;
      const status = w && !isRespawning ? windowIndicator(w.serverName, w.tmuxTarget) : null;
      const finishedAt = status === 'finished' && w
        ? finishedEntries.find((e) => e.serverName === w.serverName && e.target === w.tmuxTarget)?.finishedAt
        : undefined;
      return {
        key: tabId,
        label: w?.label || win.target,
        prefix: <span style={{ display: 'inline-flex', opacity: 0.75 }}><Icon name="terminal" size={14} /></span>,
        extra: isRespawning
          ? <Spinner size={10} />
          : (status ? <WindowActivityIndicator status={status} finishedAt={finishedAt} /> : undefined),
        closable: true,
      };
    }
    const browser = parseBrowserTabId(tabId);
    if (browser) {
      // Label by creation order within this task ("Browser", "Browser 2", ...) — matches the
      // ＋ menu's own numbering (see showAddMenu below) without needing separate label
      // storage: `browserTabIds` is already this task's browser tabs in open order.
      const idx = browserTabIds.indexOf(tabId);
      return {
        key: tabId,
        label: idx <= 0 ? t('common:labels.browser') : `${t('common:labels.browser')} ${idx + 1}`,
        prefix: <span style={{ display: 'inline-flex', opacity: 0.75 }}><Icon name="browser" size={14} /></span>,
        closable: true,
      };
    }
    return { key: tabId, label: tabId, closable: true };
  }, [windows, windowActions.respawningWindowIds, windowIndicator, finishedEntries, browserTabIds]);

  const handlePaneSelectTab = useCallback((paneId: string, tabId: string) => {
    layout.setActive(paneId, tabId);
    layout.focusPane(paneId);
  }, [layout]);

  const handlePaneCloseTab = useCallback((paneId: string, tabId: string) => {
    // Browser tabs need their own teardown beyond just removing the layout-tree entry:
    // tear down the shared-browser instance's Chromium tabs on the server side (same
    // close-group call Workspace's own browser tabs make — see closeBrowserGroup), and drop
    // it from `browserTabIds` so it stops being kept alive (useBrowserKeepalive above) and
    // doesn't get re-included in `allTabIds` on the next render.
    const browser = parseBrowserTabId(tabId);
    if (browser) {
      setBrowserTabIds((prev) => prev.filter((id) => id !== tabId));
      // The sidebar's browser list (useBrowserGroups) polls independently of this
      // task's tab layout, so it wouldn't otherwise notice this group is gone
      // until its next 30s poll — nudge it the same way page-open already does
      // (see onBrowserPageReady usage below). Wait for the close-group call to
      // settle first, or the refetch can race ahead of the server-side teardown
      // and still find the group present. The tab close itself stays synchronous
      // above; only this notification is deferred.
      void closeBrowserGroup(browser.serverName, browser.pageId).then(() => onBrowserPageReady?.());
    }
    layout.close(paneId, tabId);
  }, [layout, onBrowserPageReady]);

  const handlePaneDrop = useCallback((paneId: string, zone: DropZone, index?: number) => {
    if (!paneDrag) return;
    if (!findPane(layout.state.root, paneDrag.fromPaneId) || !findPane(layout.state.root, paneId)) {
      setPaneDrag(null);
      return;
    }
    if (zone === 'tabbar' || zone === 'center') {
      layout.move(paneDrag.tabId, paneDrag.fromPaneId, paneId, zone === 'tabbar' ? index : undefined);
    } else {
      layout.split(paneId, zone, paneDrag.tabId, paneDrag.fromPaneId);
    }
    setPaneDrag(null);
  }, [paneDrag, layout]);

  const openTabIds = useMemo(() => new Set(listPanes(layout.state.root).flatMap((p) => p.tabIds)), [layout.state.root]);

  // Reopens a closed fixed view, and always offers "ブラウザ". Window selection normally goes
  // through the restored window-list dropdown (see windowDropdownPaneId/renderPaneTrailing
  // below, which owns "+ Add window" as its footer) — but that dropdown trigger itself is
  // hidden when the project has zero windows (renderWindowDropdownTrigger returns null), which
  // left no way to add a first window. So this menu also offers "Add Window" as an
  // always-available fallback entry point into the same onOpenAddWindow flow. Unlike fixed
  // views, "ブラウザ" always creates a brand-new instance — it's never "reopening" an existing
  // one, so it isn't filtered by openTabIds.
  const showAddMenu = useCallback((e: React.MouseEvent, pane: PaneNode) => {
    const items: ContextMenuItem[] = [];
    // SP では 'unit'/'git'/'summary' は概要セグメントへ併合済み（Issue #69 T5）— 独立タブとして
    // 再度開けてしまうと、セグメント行のハイライトと実際の表示内容がずれる（下の
    // isLegacyMergedMobileView 参照）。デスクトップは従来どおり個別タブとして開ける。
    const closedViews = availableFixedViews.filter((v) =>
      !openTabIds.has(viewTabId(v)) && !(isMobile && (v === 'unit' || v === 'git' || v === 'summary')));
    closedViews.forEach((v) => items.push({
      label: t('contextMenu.showView', { view: t(`workspace:viewLabels.${v}`) }),
      onClick: () => layout.open(viewTabId(v), pane.id),
    }));
    items.push({
      label: t('contextMenu.browser'),
      icon: <Icon name="browser" size={16} />,
      disabled: !browserServerName,
      title: browserServerName ? undefined : t('contextMenu.cannotResolveServer'),
      onClick: () => {
        if (!browserServerName) return;
        const pageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const tabId = browserTabId(browserServerName, pageId);
        setBrowserTabIds((prev) => [...prev, tabId]);
        layout.open(tabId, pane.id);
      },
    });
    if (onOpenAddWindow) {
      items.push({
        label: t('contextMenu.addWindow'),
        icon: <Icon name="windows" size={16} />,
        onClick: () => onOpenAddWindow(true, task?.projectId, taskId),
      });
    }
    showCtxMenu(e, items);
  }, [availableFixedViews, openTabIds, layout, showCtxMenu, browserServerName, onOpenAddWindow, task, isMobile]);

  const showTabContextMenu = useCallback((e: React.MouseEvent, pane: PaneNode, tabId: string) => {
    const panesCount = listPanes(layout.state.root).length;
    const items: ContextMenuItem[] = [];
    if (tabId !== viewTabId('description')) {
      items.push({ label: t('contextMenu.closeTab'), icon: <Icon name="close" size={16} />, onClick: () => handlePaneCloseTab(pane.id, tabId) });
    }
    if (panesCount > 1) {
      items.push({ label: t('workspace:pane.nextPane'), icon: <Icon name="pane-next" size={16} />, onClick: () => layout.moveToNext(pane.id, tabId) });
    }
    items.push(
      { label: t('workspace:pane.splitRightAndShow'), icon: <Icon name="split-h" size={16} />, onClick: () => layout.split(pane.id, 'right', tabId, pane.id) },
      { label: t('workspace:pane.splitBelowAndShow'), icon: <Icon name="split-v" size={16} />, onClick: () => layout.split(pane.id, 'bottom', tabId, pane.id) },
    );
    // Full window operations (rename label/window/pane, capture panes, respawn,
    // show task, detach, delete) — the same getWindowMenuItems() the old
    // TaskWindowDropdown used, so removing that dropdown doesn't drop these
    // actions. "Delete window" from this list *is* the kill action; no separate
    // "Kill window" item is added, so the two never duplicate.
    const win = parseWindowTabId(tabId);
    if (win) {
      const w = windows.find((x) => x.serverName === win.serverName && isSameWindowTarget(x.tmuxTarget, win.target));
      if (w) {
        const extra = resolveWindowContextExtra(w, sessionData);
        items.push({ label: '', separator: true, onClick: () => {} });
        items.push(...windowActions.getWindowMenuItems(w, extra));
      }
    }
    showCtxMenu(e, items);
  }, [layout, windows, windowActions, showCtxMenu, sessionData, handlePaneCloseTab]);

  // Shared window-list dropdown body (pre-#397 TaskWindowDropdown) — selecting a row
  // opens/activates that window's tab in `pane`. Factored out so both the desktop trigger
  // and the two SP header pieces below (name trigger / pane-count chip, Issue #69 S8) can
  // attach the exact same dropdown to whichever one the user actually tapped, instead of
  // duplicating the onPaneClick relocation logic.
  const renderWindowDropdownBody = useCallback((pane: PaneNode) => (
    <TaskWindowDropdown
      windows={windows}
      sessionData={sessionData}
      activeTarget={focusedWindowTarget}
      onPaneClick={(serverName, target) => {
        // `layout.open` (paneLayoutTree's openTab) activates an already-open tab in
        // whichever pane it's *already* in, ignoring the preferred pane — so picking a
        // window that's already open in another pane from *this* pane's dropdown would
        // silently activate it over there instead of bringing it here. Move it
        // explicitly when it's parked in a different pane; open() already does the
        // right thing (activate in place, or place a brand-new tab here) otherwise.
        const tabId = windowTabId(serverName, target);
        const existingPane = findPaneByTab(layout.state.root, tabId);
        if (existingPane && existingPane.id !== pane.id) {
          layout.move(tabId, existingPane.id, pane.id);
        } else {
          layout.open(tabId, pane.id);
        }
      }}
      onContextMenu={windowActions.showWindowContextMenu}
      onLongPress={windowActions.showWindowContextMenuAt}
      onOpenAddWindow={onOpenAddWindow ? () => onOpenAddWindow(true, task?.projectId, taskId) : undefined}
      onClose={() => setWindowDropdownPaneId(null)}
      respawningWindowIds={windowActions.respawningWindowIds}
    />
  ), [windows, sessionData, focusedWindowTarget, layout, windowActions, onOpenAddWindow, task, taskId]);

  // Desktop per-pane trailing trigger (label + total window count badge + ▾) — unchanged
  // from before Issue #69 S8.
  const renderWindowDropdownTrigger = useCallback((pane: PaneNode) => {
    if (windows.length === 0) return null;
    const isOpen = windowDropdownPaneId === pane.id;
    const label = focusedWindowTarget
      ? (windows.find((w) => w.serverName === focusedWindowTarget.serverName && isSameWindowTarget(w.tmuxTarget, focusedWindowTarget.target))?.label
        || focusedWindowTarget.target)
      : '';
    return (
      <span style={{ position: 'relative' }}>
        <span
          onClick={(e) => { e.stopPropagation(); setWindowDropdownPaneId(isOpen ? null : pane.id); }}
          role="button"
          tabIndex={0}
          aria-label={t('workspace:windows.windowList')}
          aria-expanded={isOpen}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWindowDropdownPaneId(isOpen ? null : pane.id); } }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            cursor: 'pointer', color: 'var(--text-dim)',
            padding: '2px 6px', borderRadius: 'var(--radius-sm)',
            background: isOpen ? 'var(--bg-hover)' : 'transparent',
            fontSize: 'var(--font-xs)', maxWidth: 140,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label || t('workspace:windows.select')}
          </span>
          <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="chevron-down" size={16} rotate={isOpen ? 180 : 0} /></span>
          <span style={{
            fontSize: 'var(--font-2xs)', background: 'var(--bg)', borderRadius: 'var(--radius-md)',
            padding: '0 5px', flexShrink: 0, lineHeight: '16px',
          }}>
            {windows.length}
          </span>
        </span>
        {isOpen && renderWindowDropdownBody(pane)}
      </span>
    );
  }, [windows, windowDropdownPaneId, focusedWindowTarget, renderWindowDropdownBody, t]);

  // SP コンテンツヘッダー（承認済み S8: 「> ウィンドウ名」＋ワーカーバッジ▾＋右端「∨ Nペイン」）
  // — 旧実装は名前+件数+▾を1トリガーへ結合していたが、S8 は左（ウィンドウ名タップ＝ウィンドウ
  // 切替）と右（ペイン数チップ＝既存ドロップダウンの移設先）に分離する。両者は同じ
  // windowDropdownPaneId 開閉状態とドロップダウン本体（renderWindowDropdownBody）を共有し、
  // ドロップダウン自体は常にチップ側（右）に アンカーする。
  const renderSpWindowNameTrigger = useCallback((pane: PaneNode) => {
    if (windows.length === 0) return null;
    const isOpen = windowDropdownPaneId === pane.id;
    const label = focusedWindowTarget
      ? (windows.find((w) => w.serverName === focusedWindowTarget.serverName && isSameWindowTarget(w.tmuxTarget, focusedWindowTarget.target))?.label
        || focusedWindowTarget.target)
      : '';
    const hasMultiple = windows.length > 1;
    return (
      <span
        onClick={hasMultiple ? (e) => { e.stopPropagation(); setWindowDropdownPaneId(isOpen ? null : pane.id); } : undefined}
        role={hasMultiple ? 'button' : undefined}
        tabIndex={hasMultiple ? 0 : undefined}
        aria-label={hasMultiple ? t('workspace:windows.windowList') : undefined}
        aria-expanded={hasMultiple ? isOpen : undefined}
        onKeyDown={hasMultiple ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWindowDropdownPaneId(isOpen ? null : pane.id); } } : undefined}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0,
          cursor: hasMultiple ? 'pointer' : 'default', color: 'var(--text-dim)',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 'var(--font-sm)',
          padding: '4px 6px', borderRadius: 'var(--radius-sm)',
        }}
      >
        <span aria-hidden="true" style={{ opacity: 0.6 }}>&gt;</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
          {label || t('workspace:windows.select')}
        </span>
        {hasMultiple && <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="chevron-down" size={14} rotate={isOpen ? 180 : 0} /></span>}
      </span>
    );
  }, [windows, windowDropdownPaneId, focusedWindowTarget, t]);

  const renderSpPaneCountChip = useCallback((pane: PaneNode) => {
    if (windows.length === 0) return null;
    const isOpen = windowDropdownPaneId === pane.id;
    return (
      <span style={{ position: 'relative', flexShrink: 0 }}>
        <span
          onClick={(e) => { e.stopPropagation(); setWindowDropdownPaneId(isOpen ? null : pane.id); }}
          role="button"
          tabIndex={0}
          aria-label={t('workspace:windows.windowList')}
          aria-expanded={isOpen}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setWindowDropdownPaneId(isOpen ? null : pane.id); } }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            cursor: 'pointer', color: 'var(--text-dim)',
            padding: '5px 10px', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-hover)', fontSize: 'var(--font-xs)',
          }}
        >
          <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="chevron-down" size={14} rotate={isOpen ? 180 : 0} /></span>
          <span style={{ fontSize: 'var(--font-2xs)', whiteSpace: 'nowrap' }}>
            {t('workspace:windows.paneCount', { count: displayedWindowPaneCount ?? 1 })}
          </span>
        </span>
        {isOpen && renderWindowDropdownBody(pane)}
      </span>
    );
  }, [windows, windowDropdownPaneId, displayedWindowPaneCount, renderWindowDropdownBody, t]);

  const renderPaneTrailing = useCallback((pane: PaneNode) => {
    const panesCount = listPanes(layout.state.root).length;
    const canMerge = panesCount > 1 && pane.tabIds.length > 0;
    const canCloseEmpty = panesCount > 1 && pane.tabIds.length === 0;
    return (
      <>
        {renderWindowDropdownTrigger(pane)}
        <span onClick={(e) => showAddMenu(e, pane)}>
          <IconButton size="sm" title={t('workspace:pane.openTab')}><Icon name="plus" size={14} /></IconButton>
        </span>
        <IconButton size="sm" title={t('workspace:pane.splitRight')} onClick={() => layout.split(pane.id, 'right', null, null)}><Icon name="split-h" size={14} /></IconButton>
        <IconButton size="sm" title={t('workspace:pane.splitBelow')} onClick={() => layout.split(pane.id, 'bottom', null, null)}><Icon name="split-v" size={14} /></IconButton>
        {canMerge && (
          <IconButton size="sm" title={t('workspace:pane.merge')} onClick={() => layout.merge(pane.id)}><Icon name="merge" size={14} /></IconButton>
        )}
        {canCloseEmpty && (
          <IconButton size="sm" title={t('workspace:pane.close')} onClick={() => layout.merge(pane.id)}><Icon name="pane-close" size={14} /></IconButton>
        )}
      </>
    );
  }, [layout, showAddMenu, renderWindowDropdownTrigger]);

  const renderPaneBar = useCallback((pane: PaneNode) => (
    <MiniTabBar
      tabs={pane.tabIds.map(buildMiniTab)}
      activeKey={pane.activeTabId ?? ''}
      onSelect={(tabId) => handlePaneSelectTab(pane.id, tabId)}
      onClose={(tabId) => handlePaneCloseTab(pane.id, tabId)}
      onTabDragStart={(tabId) => setPaneDrag({ tabId, fromPaneId: pane.id })}
      onTabDragEnd={() => setPaneDrag(null)}
      onTabContextMenu={(e, tabId) => showTabContextMenu(e, pane, tabId)}
      size="md"
      trailing={renderPaneTrailing(pane)}
    />
  ), [buildMiniTab, handlePaneSelectTab, handlePaneCloseTab, showTabContextMenu, renderPaneTrailing]);

  const renderPaneEmpty = useCallback(() => (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: 'var(--font-md)', textAlign: 'center', padding: 16 }}>
      {t('workspace:pane.dragHintShort')}
    </div>
  ), []);

  function renderTabBody(
    tabId: string, tabVisible: boolean, taskData: Task,
    windowHeader?: { leading?: React.ReactNode; trailing?: React.ReactNode },
  ): React.ReactNode {
    // Only the tab that's actually active in its own pane (and only while this whole task
    // panel is visible) mounts real content — matches the terminal tab's pre-existing
    // behavior, and stops background WS/polling (TaskLogView, TaskGitTab, CommitList,
    // DiffViewer) from every fixed view tab a user has ever opened, not just the visible
    // one. A tab active in a different (also-visible) pane still mounts independently —
    // that's the multi-pane split's whole point.
    if (!tabVisible || !isVisible) return null;
    const viewName = parseViewTabId(tabId);
    // These tabs render fields that only `/tasks/:id` returns. Until it resolves they
    // are absent, which is indistinguishable from "empty" — show the pending state
    // instead of claiming the task has no description/plan/summary/diff.
    if (!detailLoaded && (viewName === 'description' || viewName === 'unit' || viewName === 'git' || viewName === 'summary')) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <Spinner />
        </div>
      );
    }
    if (viewName === 'description') {
      // SP はコンテンツヘッダーが「説明」タイトル＋編集を担う（Issue #69 S8）ため、ここでは
      // 本文のみを描く。タスクID/Issue/PR バッジと Unit/Git/サマリーは 'unit' ビュー
      // （Unit・実行情報、⋯メニューから遷移）へ移設済み — 下の 'unit' 分岐参照。
      return (
        <div className="mobile-scroll-inset" style={{ height: '100%', overflowY: 'auto', padding: '16px 24px' }}>
          {!isMobile && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 12 }}>
              <TaskRefBadges taskId={taskData.id} sourceRef={taskData.sourceRef} source={taskData.source} prUrl={taskData.prUrl} />
              {hasUnit && unit && <Chip>{t('ref.unit', { name: unit.name })}</Chip>}
            </div>
          )}
          {taskData.description ? (
            <>
              <style>{mdStyles}</style>
              <MarkdownRenderer content={taskData.description} />
            </>
          ) : (
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)', textAlign: 'center', paddingTop: 40 }}>
              {t('detail.noDescription')}
            </div>
          )}
        </div>
      );
    }
    if (viewName === 'unit') {
      // SP: 「Unit・実行情報」フルスクリーンビュー（⋯メニュー経由、Issue #69 S8）。旧概要
      // セグメントに併合していたタスクID/Issue/PR バッジ・Git・サマリーをここへ集約する
      // （'git'/'summary' はもう独立の到達先を持たない — isLegacyMergedMobileView 参照）。
      // PC はこれまでどおり Unit タブ本体（PhaseProgressBar+TaskLogView / 未割当フォーム）のみ。
      return hasUnit ? (
        <div className={isMobile ? 'mobile-scroll-inset' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: isMobile ? 'auto' : undefined, padding: isMobile ? '16px 24px' : undefined }}>
          {isMobile && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 12 }}>
              <TaskRefBadges taskId={taskData.id} sourceRef={taskData.sourceRef} source={taskData.source} prUrl={taskData.prUrl} />
              {unit && <Chip>{t('ref.unit', { name: unit.name })}</Chip>}
            </div>
          )}
          <PhaseProgressBar
            status={taskData.status}
            currentPhase={taskData.currentPhase}
            phases={findUnitType(unitTypes, unit?.unitType)?.phases.map((p) => ({ name: p.name, label: p.label })) ?? []}
            selfReviewCount={taskData.selfReviewCount}
            selfReviewMax={taskData.selfReviewMaxAttempts}
          />
          <TaskLogView
            taskId={taskData.id}
            unitId={taskData.unitId ?? undefined}
            taskStatus={taskData.status}
            planMarkdown={taskData.planMarkdown}
            fillHeight={!isMobile}
          />
          {isMobile && (
            <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
              <MobileOverviewSection title={t('workspace:viewLabels.git')}>
                <TaskGitTab
                  task={taskData}
                  projectId={taskData.projectId}
                  onSwitchToDiff={diffPath && diffServerName ? handleSwitchToDiff : undefined}
                  onRefresh={onRefresh}
                />
              </MobileOverviewSection>
              <MobileOverviewSection title={t('workspace:viewLabels.summary')}>
                <TaskSummaryTab summaryJson={taskData.summaryJson ?? null} />
              </MobileOverviewSection>
            </div>
          )}
        </div>
      ) : (
        <div className={isMobile ? 'mobile-scroll-inset' : undefined} style={isMobile ? { height: '100%', overflowY: 'auto', padding: '16px 24px' } : undefined}>
          {isMobile && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 12 }}>
              <TaskRefBadges taskId={taskData.id} sourceRef={taskData.sourceRef} source={taskData.source} prUrl={taskData.prUrl} />
            </div>
          )}
          <TaskUnitSetupForm
            task={taskData}
            allUnits={allUnits}
            defaultUnitId={projectDefaultUnitId}
            onAssignAndExecute={handleAssignAndExecute}
          />
        </div>
      );
    }
    if (viewName === 'git') {
      if (!hasUnit) return null;
      return (
        <div className="mobile-scroll-inset" style={{ height: '100%', overflowY: 'auto', padding: '16px 24px' }}>
          <TaskGitTab
            task={taskData}
            projectId={taskData.projectId}
            onSwitchToDiff={diffPath && diffServerName ? handleSwitchToDiff : undefined}
            onRefresh={onRefresh}
          />
        </div>
      );
    }
    if (viewName === 'summary') {
      if (!hasUnit) return null;
      return (
        <div className="mobile-scroll-inset" style={{ height: '100%', overflowY: 'auto', padding: '16px 24px' }}>
          <TaskSummaryTab summaryJson={taskData.summaryJson ?? null} />
        </div>
      );
    }
    if (viewName === 'commits') {
      if (!diffPath || !diffServerName) return null;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <div style={{ flexShrink: 0, maxHeight: selectedCommit ? '40%' : '100%', overflow: 'hidden', borderBottom: selectedCommit ? '1px solid var(--border)' : 'none', transition: 'max-height 0.15s ease' }}>
            <CommitList
              serverName={diffServerName}
              path={diffPath}
              baseBranch={taskData.baseBranch || undefined}
              selectedHash={selectedCommit}
              onSelectCommit={setSelectedCommit}
            />
          </div>
          {selectedCommit && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <DiffViewer
                serverName={diffServerName}
                path={diffPath}
                commit={selectedCommit}
                onOpenFile={handleOpenDiffFile}
              />
            </div>
          )}
        </div>
      );
    }
    if (viewName === 'diff') {
      if (!diffPath || !diffServerName) return null;
      return (
        <DiffViewer
          serverName={diffServerName}
          path={diffPath}
          baseBranch={taskData.baseBranch || undefined}
          initialFile={diffActiveFile}
          onOpenFile={handleOpenDiffFile}
        />
      );
    }
    const win = parseWindowTabId(tabId);
    if (win) {
      const { serverName, target } = resolveWindowTabTarget(win);
      return (
        <TerminalContainer
          key={`terminal-${serverName}-${target}`}
          serverName={serverName}
          target={target}
          taskId={taskData.id}
          allTasks={allTasks}
          sessions={sessionData[serverName]}
          onWindowChanged={() => { fetchTaskData(); onRefresh(); }}
          onSplitPane={onSplitPane ? (dir) => onSplitPane(serverName, target, dir) : undefined}
          onOpenTask={onOpenTask}
          reconnectKey={reconnectKeys[tabId]}
          leading={windowHeader?.leading}
          trailing={windowHeader?.trailing}
          // SP: 端末/チャットは下端ミニトグル（TerminalChatToggle、qbar/PromptInputBar）で
          // 選択する第一級モードのため、TerminalContainer 内蔵の端末⇄チャットトグル（上部
          // ツールバー）は使わず TaskPanel が単一の真実源として制御する（Issue #69 S8）。
          // デスクトップはこの prop を渡さず、従来どおり自律的に管理する（不変）。
          viewMode={isMobile ? mobileViewMode : undefined}
          onViewModeChange={isMobile ? (mode) => setMobileViewMode(mode, focusedWindowId) : undefined}
        />
      );
    }
    const browser = parseBrowserTabId(tabId);
    if (browser) {
      return (
        <BrowserView
          key={`browser-${browser.serverName}-${browser.pageId}`}
          serverName={browser.serverName}
          groupId={browser.pageId}
          // v1: persisting which Chromium tab (within the group) was last active is out of
          // scope for task-scoped browser tabs — a reload always reopens on the group's
          // default tab. Left as a real (no-op) callback rather than omitted, so this stays
          // a deliberate choice (documented here) instead of looking like a forgotten wire-up.
          onActiveTabChange={() => {}}
          onPageReady={onBrowserPageReady}
        />
      );
    }
    return null;
  }

  // Mobile: single segmented row + single view, reading off the same task-scoped layout
  // tree (the focused pane's active tab) rather than a parallel state/persistence
  // mechanism — smaller diff, and keeps one source of truth for both layouts.
  const mobileTabIds = useMemo(() => listPanes(layout.state.root).flatMap((p) => p.tabIds), [layout.state.root]);
  const mobileFocusedPane = layout.state.focusedPaneId ? findPane(layout.state.root, layout.state.focusedPaneId) : null;
  const mobileActiveTabId = mobileFocusedPane?.activeTabId ?? mobileTabIds[0] ?? viewTabId('description');
  // layout.open()（既存の openTab）を使う — findPaneByTab + setActive では、まだどの
  // ペインの tabIds にも入っていないタブ（Issue #69 修正3で常時セグメント表示になった
  // unit/git/summary/commits/diff や、初回選択されるウィンドウタブ）を選択しても
  // pane が見つからず無反応になる。open() は「既存なら activate、未登録なら追加して
  // activate」を両方担うため、セグメント選択はこちらに統一する。
  const handleMobileSelect = useCallback((tabId: string) => {
    layout.open(tabId);
  }, [layout]);

  // SP のコンテンツ選択は S8 で ⋯ メニュー／ウィンドウ名タップ／下部ミニトグルへ一本化された
  // （旧セグメント行は撤去、Issue #69 S8）。「端末」「チャット」は独立ビューではなく同じ
  // 「直近アクティブだったウィンドウタブ」に対する表示モード切替 — 実際のウィンドウ切替は
  // コンテンツヘッダーのウィンドウ名タップ／ペイン数チップ（renderSpWindowNameTrigger /
  // renderSpPaneCountChip）が担う（未選択時/そのウィンドウが閉じられた時は先頭のウィンドウへ
  // フォールバック、旧実装から維持）。
  const MOBILE_TERMINAL_SEGMENT = '__terminal__';
  const MOBILE_CHAT_SEGMENT = '__chat__';
  const lastMobileWindowTabIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (parseWindowTabId(mobileActiveTabId)) lastMobileWindowTabIdRef.current = mobileActiveTabId;
  }, [mobileActiveTabId]);

  // S8 の ⋯ メニューには 'git'/'summary' 単独の行はなく、両者は 'unit'（Unit・実行情報）
  // フルスクリーンビューへ併合されている（下の renderTabBody 'unit' 分岐参照）。既存の
  // 永続レイアウトからこれらが旧アクティブタブとして復元された場合、'unit' へフォールバック
  // する。'unit' 自体は S8 で第一級の ⋯ メニュー遷移先になったため、もうフォールバック対象
  // ではない。
  const mobileActiveViewName = parseViewTabId(mobileActiveTabId);
  const isLegacyMergedMobileView = mobileActiveViewName === 'git' || mobileActiveViewName === 'summary';

  const mobileActiveSegment = parseWindowTabId(mobileActiveTabId)
    ? (mobileViewMode === 'chat' ? MOBILE_CHAT_SEGMENT : MOBILE_TERMINAL_SEGMENT)
    : (isLegacyMergedMobileView ? viewTabId('unit') : mobileActiveTabId);

  const handleMobileSegmentSelect = useCallback((key: string) => {
    if (key === MOBILE_TERMINAL_SEGMENT || key === MOBILE_CHAT_SEGMENT) {
      const mode: WindowViewMode = key === MOBILE_CHAT_SEGMENT ? 'chat' : 'terminal';
      const remembered = lastMobileWindowTabIdRef.current;
      const target = remembered && windowTabIdsList.includes(remembered) ? remembered : windowTabIdsList[0];
      if (!target) return;
      handleMobileSelect(target);
      const win = parseWindowTabId(target);
      const w = win ? windows.find((x) => x.serverName === win.serverName && isSameWindowTarget(x.tmuxTarget, win.target)) : undefined;
      setMobileViewMode(mode, w?.id ?? null);
      return;
    }
    handleMobileSelect(key);
  }, [handleMobileSelect, windowTabIdsList, windows, setMobileViewMode]);

  // 端末/チャットセグメント選択中に表示するウィンドウタブ id — mobileActiveTabId がまだ
  // ウィンドウタブへ切り替わっていない最初のレンダーでも取りこぼさないよう、直近記憶値/
  // 先頭ウィンドウへフォールバックする（承認済みモックの「ウィンドウバー」は常に何らかの
  // ウィンドウを表示している状態を前提とするため）。
  const mobileDisplayedWindowTabId = parseWindowTabId(mobileActiveTabId)
    ? mobileActiveTabId
    : (lastMobileWindowTabIdRef.current && windowTabIdsList.includes(lastMobileWindowTabIdRef.current)
      ? lastMobileWindowTabIdRef.current
      : windowTabIdsList[0]);

  if (!task) return <div style={{ padding: 24, color: 'var(--text-dim)', background: 'var(--ws-surface)', height: '100%' }}>{t('detail.notFound')}</div>;

  const backButton = onBack && (
    <button onClick={onBack} aria-label={t('common:actions.back')} style={{
      width: 28, height: 28, borderRadius: 'var(--radius-sm)', border: 'none',
      background: 'none', color: 'var(--text-dim)', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
        <path d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );

  const moreButtonStyle: React.CSSProperties = {
    width: 28, height: 28, border: '1px solid var(--border)',
    color: 'var(--text-dim)', cursor: 'pointer',
    fontSize: 'var(--font-lg)', lineHeight: 1, display: 'flex', alignItems: 'center',
    justifyContent: 'center', flexShrink: 0,
  };

  // SP ⋯ フルサイズメニュー（TaskDetailMenu）のタスク全体アクション — 旧 SP ⋯
  // コンテキストメニュー（moreMenu）が持っていた項目をそのまま移設する（機能欠落防止）。
  const taskDetailMenuActions = [
    ...(hasUnit && unit && task.status === 'open'
      ? [{ label: t('actions.execute'), icon: <Icon name="play" size={16} />, onClick: () => executeTask(task.id, unit.id) }]
      : []),
    ...(task.status === 'in_progress' && hasUnit && unit
      ? [{ label: t('actions.stop'), icon: <Icon name="stop" size={16} />, danger: true, onClick: () => stopTask(unit.id) }]
      : []),
    { label: t('actions.edit'), icon: <Icon name="edit" size={16} />, onClick: () => onEdit?.(taskId) },
    ...(task.status === 'archived'
      ? [{ label: t('actions.restore'), icon: <Icon name="refresh" size={16} />, onClick: handleRestore }]
      : [{ label: t('actions.archive'), icon: <Icon name="storage" size={16} />, onClick: handleArchive }]),
    { label: t('common:actions.delete'), icon: <Icon name="trash" size={16} />, danger: true, onClick: handleDelete },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ws-surface)' }}>
      {/* Task header bar: SP = タイトル行のみ（承認済み S8: チップ行(既存タブバー)→タイトル行→
          コンテンツヘッダー→コンテンツ→下部文脈バー）, PC = single row（不変） */}
      {isMobile ? (
        <div className="ws-surface" style={{ background: 'var(--ws-surface-card)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          {/* タイトル行: タスクタイトル（1行省略）＋右端 ⋯ のみ（◀/状態ピル/旧セグメント行は
              いずれも撤去 — ステータスは ⋯ メニュー「ステータス」節へ、◀は既存タブ切替に委譲、
              セグメント行の内容はコンテンツヘッダー＋⋯メニューへ再構成、Issue #69 S8）。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, padding: '0 var(--space-3)' }}>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 'var(--font-base)', fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {task.title}
            </span>
            <button
              onClick={() => setDetailMenuOpen(true)}
              className="icon-btn"
              style={moreButtonStyle}
              title={t('common:navigation.moreActions')}
              aria-label={t('common:navigation.moreActions')}
            ><Icon name="more" size={14} /></button>
          </div>
        </div>
      ) : (
        <PanelHeader
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              {backButton}
              <StatusDot status={task.status} />
              <TaskRefBadges taskId={task.id} sourceRef={task.sourceRef} source={task.source} prUrl={task.prUrl} />
              <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {task.title}
              </span>
              <StatusDropdown status={task.status} onChange={handleStatusChange} />
            </div>
          }
          actions={
            <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
              {hasUnit && unit && task.status === 'open' && <Button variant="primary" size="sm" onClick={() => executeTask(task.id, unit.id)}>{t('actions.execute')}</Button>}
              {task.status === 'in_progress' && hasUnit && unit && <Button variant="danger" size="sm" onClick={() => stopTask(unit.id)}>{t('actions.stop')}</Button>}
              <button
                onClick={(e) => moreMenu.show(e, [
                  { label: t('actions.edit'), icon: <Icon name="edit" size={16} />, onClick: () => onEdit?.(taskId) },
                  ...(task.status === 'archived'
                    ? [{ label: t('actions.restore'), icon: <Icon name="refresh" size={16} />, onClick: handleRestore }]
                    : [{ label: t('actions.archive'), icon: <Icon name="storage" size={16} />, onClick: handleArchive }]),
                  { label: t('common:actions.delete'), icon: <Icon name="trash" size={16} />, danger: true, onClick: handleDelete },
                ])}
                className="icon-btn"
                style={moreButtonStyle}
                title={t('common:navigation.moreActions')}
              ><Icon name="more" size={14} /></button>
            </div>
          }
        />
      )}

      {/* Planning approval bar (operation only) */}
      {hasUnit && task.status === 'phase_review' && (
        <div style={{ borderBottom: '1px solid var(--border)', background: 'rgba(255,166,0,0.05)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '12px 16px' }}>
            <span style={{ fontSize: 'var(--font-md)', color: '#ffa600', fontWeight: 500 /* lint-allow: hex - dedicated "plan review pending" attention color, not part of the success/warning/danger triad yet */ }}>{t('planReview.required')}</span>
          </div>
          <div style={{ padding: '0 16px 12px' }}>
            <textarea
              data-plan-feedback
              defaultValue=""
              placeholder={t('planReview.placeholder')}
              rows={2}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handlePlanAction(task, true); } }}
              style={{ width: '100%', padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="danger" size="sm" onClick={() => handlePlanAction(task, false)}>{t('planReview.reject')}</Button>
              <Button size="sm" onClick={() => handlePlanAction(task, false)} style={{ borderColor: '#ffa600', color: '#ffa600' /* lint-allow: hex - dedicated "plan review pending" attention color, not part of the success/warning/danger triad yet */ }}>{t('planReview.rePlan')}</Button>
              <Button variant="primary" size="sm" onClick={() => handlePlanAction(task, true)}>{t('planReview.approve')}</Button>
            </div>
          </div>
          {task.planMarkdown && (
            <div style={{ padding: '0 16px 12px', maxHeight: 400, overflowY: 'auto' }}>
              <style>{mdStyles}</style>
              <MarkdownRenderer content={task.planMarkdown} />
            </div>
          )}
        </div>
      )}

      {/* Pending questions bar (operation only) */}
      {hasUnit && task.status === 'waiting_input' && (() => {
        const questions: Array<{ text: string; type: 'select' | 'text'; options?: string[]; selected?: number }> = (() => {
          try { return task.pendingQuestions ? JSON.parse(task.pendingQuestions) : []; }
          catch { return []; }
        })();
        return (
          <div style={{ borderBottom: '1px solid var(--border)', background: 'rgba(100,149,237,0.08)', flexShrink: 0 }}>
            <div style={{ padding: '12px 16px', fontSize: 'var(--font-md)', color: '#6495ed', fontWeight: 500 /* lint-allow: hex - dedicated "waiting for input" attention color, not part of the success/warning/danger triad yet */ }}>
              {questions.length > 0
                ? t('questions.asking', { count: questions.length })
                : t('questions.waitingInput')}
            </div>
            {questions.length > 0 && (
              <div style={{ padding: '0 16px 12px' }}>
                {questions.map((q, qi) => (
                  <div key={qi} style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 'var(--font-md)', color: 'var(--text)', marginBottom: 6 }}>{q.text}</div>
                    {q.type === 'select' && q.options ? (
                      <select
                        data-question-index={qi}
                        defaultValue={q.selected ?? 0}
                        style={{ padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', width: '100%' }}
                      >
                        {q.options.map((opt, oi) => (
                          <option key={oi} value={oi}>{opt}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        data-question-index={qi}
                        placeholder={t('questions.answerPlaceholder')}
                        style={{ padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', width: '100%', boxSizing: 'border-box' }}
                      />
                    )}
                  </div>
                ))}
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 6 }}>{t('questions.additionalComments')}</div>
                  <textarea
                    data-answer-additional
                    placeholder={t('questions.additionalCommentsPlaceholder')}
                    rows={3}
                    style={{ padding: '6px 10px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  loading={submittingAnswers}
                  loadingLabel={t('questions.submitting')}
                  onClick={async () => {
                    if (submittingAnswers) return;
                    setSubmittingAnswers(true);
                    const answers = questions.map((q, qi) => {
                      const el = document.querySelector(`[data-question-index="${qi}"]`) as HTMLSelectElement | HTMLInputElement | null;
                      if (!el) return { index: qi, value: 0 };
                      return { index: qi, value: q.type === 'select' ? parseInt(el.value, 10) : el.value };
                    });
                    const additionalEl = document.querySelector('[data-answer-additional]') as HTMLTextAreaElement | null;
                    const additionalComment = additionalEl?.value.trim() || '';
                    try {
                      const res = await api<{ error?: string }>(`/tasks/${task.id}/answer`, { method: 'POST', body: JSON.stringify({ answers, additionalComment }), headers: { 'Content-Type': 'application/json' } });
                      if (res.error) {
                        showToast(res.error);
                        setSubmittingAnswers(false);
                        return;
                      }
                      onRefresh();
                    } catch {
                      setSubmittingAnswers(false);
                    }
                  }}
                >{t('questions.submitAnswers')}</Button>
              </div>
            )}
          </div>
        );
      })()}

      {/* Execution approval gate (Issue #51) — untrusted-origin task blocked
          before any worker/worktree/secret is touched. Deliberately renders
          task.title/description as PLAIN TEXT (never MarkdownRenderer): this
          content can be attacker-authored (imported from an external
          GitHub/GitLab issue), and rendering it as markdown/HTML on an
          approval screen would let it forge links, images, or layout that
          impersonates AZITO's own UI. */}
      {task.status === 'pending_approval' && (
        <div
          role="region"
          aria-label={t('executionApproval.regionLabel')}
          style={{ borderBottom: '1px solid var(--border)', background: 'var(--danger-a08)', flexShrink: 0, maxHeight: '60%', overflowY: 'auto' }}
        >
          <div style={{ padding: '12px 16px 4px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 'var(--font-md)', color: 'var(--danger)', fontWeight: 600 }}>
              {t('executionApproval.title')}
            </span>
            <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
              {t('executionApproval.whyRequired')}
            </span>
          </div>

          <div aria-live="polite" style={{ padding: '0 16px' }}>
            {approvalLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
                <Spinner size={14} />
                {t('executionApproval.loading')}
              </div>
            )}
            {!approvalLoading && approvalError && (
              <div style={{ padding: '8px 0', color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
                {approvalError}
              </div>
            )}
          </div>

          {!approvalLoading && approvalData && (
            <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Untrusted content — plain text, visually distinct from AZITO's own UI chrome. */}
              <div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--danger)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                  {t('executionApproval.untrustedContentLabel')}
                </div>
                <div style={{
                  border: '1px dashed var(--danger-a35)', borderRadius: 'var(--radius-md)', background: 'var(--bg)',
                  padding: '10px 12px', maxHeight: 260, overflowY: 'auto',
                }}>
                  <div style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text)', marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {approvalData.title}
                  </div>
                  <pre style={{
                    margin: 0, fontFamily: 'inherit', fontSize: 'var(--font-sm)', color: 'var(--text)',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {approvalData.description || t('executionApproval.noDescription')}
                  </pre>
                </div>
              </div>

              {/* Resolved execution context — where/what/which secrets. */}
              <div>
                <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                  {t('executionApproval.contextLabel')}
                </div>
                <div style={{
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg)',
                  padding: '10px 12px', display: 'grid', gridTemplateColumns: 'max-content 1fr', rowGap: 6, columnGap: 12,
                  fontSize: 'var(--font-sm)',
                }}>
                  <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.unit')}</span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{approvalData.execution.unitName ?? t('executionApproval.unresolved')}</span>

                  <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.server')}</span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{approvalData.execution.serverName ?? t('executionApproval.unresolved')}</span>

                  <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.workingDirectory')}</span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>{approvalData.execution.workingDirectory ?? t('executionApproval.unresolved')}</span>

                  <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.branches')}</span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
                    {t('executionApproval.branchesValue', {
                      base: approvalData.execution.branches.base || '—',
                      target: approvalData.execution.branches.target || '—',
                      work: approvalData.execution.branches.work || '—',
                    })}
                  </span>

                  <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.phases')}</span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
                    {approvalData.execution.phases.length > 0
                      ? approvalData.execution.phases.map((p) => `${p.phase} (${p.sidekickName ?? t('executionApproval.unresolved')})`).join(', ')
                      : t('executionApproval.unresolved')}
                  </span>

                  <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.repository')}</span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
                    {approvalData.execution.repository
                      ? (approvalData.execution.repository.owner && approvalData.execution.repository.repoName
                        ? `${approvalData.execution.repository.owner}/${approvalData.execution.repository.repoName}`
                        : approvalData.execution.repository.url)
                      : t('executionApproval.noRepository')}
                  </span>

                  <span style={{ color: 'var(--text-dim)' }}>{t('executionApproval.fields.secrets')}</span>
                  <span style={{ color: 'var(--text)', wordBreak: 'break-word' }}>
                    {approvalData.secretNames.length > 0 ? approvalData.secretNames.join(', ') : t('executionApproval.noSecrets')}
                  </span>
                </div>
              </div>

              <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
                {t('executionApproval.reapprovalNote')}
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={submittingApproval !== null}
                  loading={submittingApproval === 'deny'}
                  loadingLabel={t('executionApproval.denying')}
                  onClick={() => handleExecutionApproval(false)}
                >{t('executionApproval.deny')}</Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={submittingApproval !== null}
                  loading={submittingApproval === 'approve'}
                  loadingLabel={t('executionApproval.approving')}
                  onClick={() => handleExecutionApproval(true)}
                >{t('executionApproval.approve')}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main content area (full width, no sidebar) */}
      {isMobile ? (() => {
        const activePane = mobileFocusedPane ?? listPanes(layout.state.root)[0];
        const isWindowContent = (mobileActiveSegment === MOBILE_TERMINAL_SEGMENT || mobileActiveSegment === MOBILE_CHAT_SEGMENT) && !!mobileDisplayedWindowTabId;
        const resolvedViewTabId = isLegacyMergedMobileView ? viewTabId('unit') : mobileActiveTabId;
        const resolvedViewName = isWindowContent ? null : parseViewTabId(resolvedViewTabId);
        const isBrowserContent = !isWindowContent && !!parseBrowserTabId(resolvedViewTabId);
        // コンテンツヘッダー（承認済み S8）: 端末/チャットは TerminalContainer 自身の
        // leading/trailing（ウィンドウ名タップ＋ワーカーバッジ▾＋ペイン数チップ）が担う。
        // ブラウザは BrowserView 自身のツールバー（アドレスバー/タブ）がページタイトルを
        // 兼ねるため、ここでは重ねて描かない。それ以外の固定ビューはこの MobileContentHeader
        // を使う（説明のみ「編集」アクション付き）。
        const contentHeaderTitle = resolvedViewName === 'description' ? t('workspace:viewLabels.description')
          : resolvedViewName === 'unit' ? t('workspace:taskDetailMenu.unitAndExecution')
          : resolvedViewName === 'commits' ? t('workspace:viewLabels.commits')
          : resolvedViewName === 'diff' ? t('workspace:viewLabels.diff')
          : null;
        return (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            {contentHeaderTitle && (
              <MobileContentHeader
                title={contentHeaderTitle}
                action={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {resolvedViewName === 'description' && onEdit && (
                      <button
                        type="button"
                        onClick={() => onEdit(taskId)}
                        style={{ border: 'none', background: 'none', color: 'var(--accent)', fontSize: 'var(--font-xs)', fontWeight: 600, cursor: 'pointer', padding: '4px 0' }}
                      >
                        {t('actions.edit')}
                      </button>
                    )}
                    {/* ウィンドウ/ブラウザ追加（windows.length===0 でも到達できる唯一の入口、
                        Issue #69 S8）。ウィンドウ/チャット表示中はコンテンツヘッダー右端の
                        ペイン数チップ隣に別途置くため、ここには非ウィンドウ系ビューでのみ出す。 */}
                    <span onClick={(e) => showAddMenu(e, activePane)}>
                      <IconButton size="sm" title={t('workspace:pane.openTab')}><Icon name="plus" size={14} /></IconButton>
                    </span>
                  </div>
                }
              />
            )}
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              {isWindowContent && mobileDisplayedWindowTabId
                ? renderTabBody(
                  mobileDisplayedWindowTabId,
                  true,
                  task,
                  {
                    leading: renderSpWindowNameTrigger(activePane),
                    trailing: (
                      <>
                        {renderSpPaneCountChip(activePane)}
                        {/* ウィンドウ/ブラウザ追加の唯一の入口（Issue #69 S8 で旧セグメント行の
                            常設＋を撤去したため、機能欠落を避けるためここへ移設）。 */}
                        <span onClick={(e) => showAddMenu(e, activePane)}>
                          <IconButton size="sm" title={t('workspace:pane.openTab')}><Icon name="plus" size={14} /></IconButton>
                        </span>
                      </>
                    ),
                  },
                )
                : renderTabBody(resolvedViewTabId, true, task)}
            </div>
            {/* 下部文脈バー（端末/チャット以外）: 端末/チャットは qbar/PromptInputBar 自身が
                ミニトグルを描くため、ここでは非端末/チャット表示中のみ描く（Issue #69 S8）。 */}
            {!isWindowContent && !isBrowserContent && (
              <MobileContextFooter
                value={mobileViewMode}
                onChange={(mode) => handleMobileSegmentSelect(mode === 'chat' ? MOBILE_CHAT_SEGMENT : MOBILE_TERMINAL_SEGMENT)}
                disabled={windowTabIdsList.length === 0}
              />
            )}
          </div>
        );
      })() : (
        <div ref={paneRects.containerRef} style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
          <SplitLayout
            root={layout.state.root}
            focusedPaneId={layout.state.focusedPaneId}
            drag={paneDrag}
            renderPaneBar={renderPaneBar}
            renderPaneEmpty={renderPaneEmpty}
            onFocusPane={layout.focusPane}
            onResize={layout.resize}
            onDrop={handlePaneDrop}
            onPaneBodyRef={paneRects.onPaneBodyRef}
          />
          {Array.from(openTabIds).map((tabId) => {
            const pane = findPaneByTab(layout.state.root, tabId);
            const rect = pane ? paneRects.rects[pane.id] : undefined;
            const tabVisible = !!pane && pane.activeTabId === tabId;
            // Gate on the outer `isVisible` too (Issue #397 multi-pane regression): this
            // overlay unconditionally sets visibility:visible/pointer-events:auto when
            // `tabVisible`, which — being a descendant style — overrides an ancestor
            // TabContentRenderer's visibility:hidden/pointer-events:none for a workspace
            // task tab that isn't the active one. Without this, a hidden-but-mounted
            // task's own active-pane overlay stays hit-testable and sits on top of
            // whichever workspace tab actually is visible (see TabContentRenderer.tsx).
            const overlayVisible = isVisible && tabVisible;
            const interactive = overlayVisible && !paneDrag;
            return (
              <div
                key={tabId}
                data-overlay-scope="task"
                data-tab-id={tabId}
                style={computeTabOverlayStyle(rect, overlayVisible, interactive)}
                onPointerDownCapture={interactive ? () => { if (pane) layout.focusPane(pane.id); } : undefined}
              >
                {renderTabBody(tabId, tabVisible, task)}
              </div>
            );
          })}
        </div>
      )}

      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={hideCtxMenu} />}
      {moreMenu.menu && <ContextMenu menu={moreMenu.menu} onClose={moreMenu.hide} />}

      {isMobile && (
        <TaskDetailMenu
          open={detailMenuOpen}
          onClose={() => setDetailMenuOpen(false)}
          task={task}
          unitName={unit?.name}
          hasUnit={hasUnit}
          actions={taskDetailMenuActions}
          diffPath={diffPath}
          diffServerName={diffServerName}
          browserCount={browserTabIds.length}
          onStatusChange={handleStatusChange}
          onOpenDescription={() => handleMobileSelect(viewTabId('description'))}
          onOpenUnit={() => handleMobileSelect(viewTabId('unit'))}
          onOpenCommits={() => handleMobileSelect(viewTabId('commits'))}
          onOpenDiff={() => handleMobileSelect(viewTabId('diff'))}
          onOpenBrowser={() => { if (browserTabIds[0]) handleMobileSelect(browserTabIds[0]); }}
          isPinned={isPinned}
          onTogglePin={() => togglePin?.(ownTabId)}
          onCloseTab={() => closeTab?.(ownTabId)}
        />
      )}

      {windowActions.confirmDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'var(--overlay)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300, padding: 16 }}>
          <div style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20, maxWidth: 400, width: '100%' }}>
            <h3 style={{ fontSize: 'var(--font-lg)', marginBottom: 12 }}>{windowActions.confirmDialog.title}</h3>
            <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 20 }}>{windowActions.confirmDialog.message}</p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={() => windowActions.setConfirmDialog(null)} disabled={windowActions.windowActionLoading}>{t('common:actions.cancel')}</Button>
              <Button variant="danger" onClick={windowActions.confirmDialog.onConfirm} loading={windowActions.windowActionLoading} loadingLabel={t('common:actions.processing')}>
                {t('common:actions.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ResourceWarningDialog
        open={windowActions.respawnResourceWarning !== null}
        title={t('workspace:resourceWarning.title')}
        resources={windowActions.respawnResourceWarning?.resources ?? null}
        actionLabel={t('workspace:resourceWarning.restartAnyway')}
        onCancel={() => windowActions.setRespawnResourceWarning(null)}
        onForce={() => windowActions.respawnResourceWarning?.retry()}
      />
    </div>
  );
}
