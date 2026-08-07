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
import { TerminalContainer } from '../TerminalContainer';
import { DiffViewer, CommitList } from '../diff';
import ContextMenu, { useContextMenu, type ContextMenuItem } from '../ContextMenu';
import ResourceWarningDialog from '../ResourceWarningDialog';
import PhaseProgressBar from './PhaseProgressBar';
import StatusDropdown from '../task/StatusDropdown';
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
import type { Task, Unit, Window, Session, Project } from '../../pages/workspace/types';
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
  makeTaskLayoutStorage, SELECT_BROWSER_EVENT, SELECT_TERMINAL_EVENT, resolveWindowContextExtra,
  resolveDisplayedTaskTerminal, selectTaskTerminal,
  type FixedView, type TerminalRef,
} from '../task/taskPaneLayout';

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
}

export default function TaskPanel({
  taskId, isVisible = true, isPaneFocused = true, allUnits, tasks, allTasks, projects, currentProject, sessionData,
  executeTask, stopTask, onRefresh, onBack, onDelete, onEdit, onOpenAddWindow,
  onSplitPane, onOpenTask, tabs, closeTab, projectServers, onOpenFile,
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
  // Restored window-list dropdown (the pre-#397 TaskWindowDropdown) — at most one open at a
  // time, keyed by the pane whose trailing trigger opened it, since opening a window from
  // it targets that specific pane.
  const [windowDropdownPaneId, setWindowDropdownPaneId] = useState<string | null>(null);
  // Working/blocked/finished activity indicator for window tabs — the same source
  // WindowsSidebar/the old TaskWindowDropdown/TaskWindowListView used, so a window tab
  // shows the same per-window activity state as every other window surface.
  const { windowIndicator, finishedEntries } = useAgentActivity();

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
      closeBrowserGroup(browser.serverName, browser.pageId);
      setBrowserTabIds((prev) => prev.filter((id) => id !== tabId));
    }
    layout.close(paneId, tabId);
  }, [layout]);

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
    const closedViews = availableFixedViews.filter((v) => !openTabIds.has(viewTabId(v)));
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
  }, [availableFixedViews, openTabIds, layout, showCtxMenu, browserServerName, onOpenAddWindow, task]);

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

  // Restored window-list trigger (pre-#397 TaskWindowDropdown) — label + count + ▾, same
  // as before. Selecting a row now opens/activates that window's tab in `pane` instead of
  // setting a panel-wide terminalTarget. Shared between the desktop per-pane trailing area
  // and the mobile trailing area (mobile has no per-pane concept of its own, so callers
  // pass the pane a mobile "open window" action should target — mirrors how mobile's ➕
  // already falls back to `mobileFocusedPane ?? listPanes(...)[0]`).
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
          <span style={{
            fontSize: 'var(--font-2xs)', background: 'var(--bg)', borderRadius: 'var(--radius-md)',
            padding: '0 5px', flexShrink: 0, lineHeight: '16px',
          }}>
            {windows.length}
          </span>
          <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="chevron-down" size={16} rotate={isOpen ? 180 : 0} /></span>
        </span>
        {isOpen && (
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
        )}
      </span>
    );
  }, [windows, sessionData, windowDropdownPaneId, focusedWindowTarget, layout, windowActions, onOpenAddWindow, task]);

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

  function renderTabBody(tabId: string, tabVisible: boolean, taskData: Task): React.ReactNode {
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
      return (
        <div className="mobile-scroll-inset" style={{ height: '100%', overflowY: 'auto', padding: '16px 24px' }}>
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
      return hasUnit ? (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
            fillHeight
          />
        </div>
      ) : (
        <TaskUnitSetupForm
          task={taskData}
          allUnits={allUnits}
          defaultUnitId={projectDefaultUnitId}
          onAssignAndExecute={handleAssignAndExecute}
        />
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
        />
      );
    }
    return null;
  }

  // Mobile: single MiniTabBar + single view, reading off the same task-scoped layout
  // tree (the focused pane's active tab) rather than a parallel state/persistence
  // mechanism — smaller diff, and keeps one source of truth for both layouts.
  const mobileTabIds = useMemo(() => listPanes(layout.state.root).flatMap((p) => p.tabIds), [layout.state.root]);
  const mobileFocusedPane = layout.state.focusedPaneId ? findPane(layout.state.root, layout.state.focusedPaneId) : null;
  const mobileActiveTabId = mobileFocusedPane?.activeTabId ?? mobileTabIds[0] ?? viewTabId('description');
  const handleMobileSelect = useCallback((tabId: string) => {
    const pane = findPaneByTab(layout.state.root, tabId);
    if (pane) handlePaneSelectTab(pane.id, tabId);
  }, [layout.state.root, handlePaneSelectTab]);
  const handleMobileClose = useCallback((tabId: string) => {
    const pane = findPaneByTab(layout.state.root, tabId);
    if (pane) handlePaneCloseTab(pane.id, tabId);
  }, [layout.state.root, handlePaneCloseTab]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--ws-surface)' }}>
      {/* Task header bar: SP = 2-row (badges row + clamped title), PC = single row */}
      {isMobile ? (
        <PanelHeader
          style={{ padding: '8px var(--space-4)', minHeight: 0 }}
          title={
            <div style={{ minWidth: 0, flex: 1 }}>
              {/* Row 1: back + badges + status + more */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {backButton}
                <StatusDot status={task.status} />
                <div style={{ minWidth: 0, overflow: 'hidden', flexShrink: 1 }}>
                  <TaskRefBadges taskId={task.id} sourceRef={task.sourceRef} source={task.source} prUrl={task.prUrl} />
                </div>
                <StatusDropdown status={task.status} onChange={handleStatusChange} />
                <div style={{ flex: 1, minWidth: 0 }} />
                <button
                  onClick={(e) => moreMenu.show(e, [
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
                  ])}
                  className="icon-btn"
                  style={moreButtonStyle}
                  title={t('common:navigation.moreActions')}
                ><Icon name="more" size={14} /></button>
              </div>
              {/* Row 2: title */}
              <div style={{
                fontSize: 'var(--font-base)', fontWeight: 600, lineHeight: 1.4,
                paddingLeft: onBack ? 36 : 0, paddingTop: 4, paddingBottom: 2,
                display: '-webkit-box', WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical' as const, overflow: 'hidden',
              }}>
                {task.title}
              </div>
            </div>
          }
        />
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

      {/* Main content area (full width, no sidebar) */}
      {isMobile ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          <div className="ws-surface" style={{ background: 'var(--ws-surface-card)', flexShrink: 0 }}>
            <MiniTabBar
              tabs={mobileTabIds.map(buildMiniTab)}
              activeKey={mobileActiveTabId}
              onSelect={handleMobileSelect}
              onClose={handleMobileClose}
              size="md"
              trailing={
                <>
                  {renderWindowDropdownTrigger(mobileFocusedPane ?? listPanes(layout.state.root)[0])}
                  <span onClick={(e) => showAddMenu(e, mobileFocusedPane ?? listPanes(layout.state.root)[0])}>
                    <IconButton size="sm" title={t('workspace:pane.openTab')}><Icon name="plus" size={14} /></IconButton>
                  </span>
                </>
              }
            />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {renderTabBody(mobileActiveTabId, true, task)}
          </div>
        </div>
      ) : (
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
