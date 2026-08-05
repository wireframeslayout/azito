import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation, matchPath } from 'react-router-dom';
import { paths, matchWorkspacePath } from '../paths';
import { api } from '../api/client';
import ContextMenu, { useContextMenu, type ContextMenuItem } from '../components/ContextMenu';
import { useProjectSettings, type SettingsSection } from '../components/ProjectSettings';
import { LoadingState, TabBar, Button, EmptyState, IconButton } from '../components/ui';
import type { TabItem } from '../components/ui';
import { Icon, type IconName } from '../components/ui/Icon';
import { useTabPersistence, type PersistedTab } from '../hooks/useTabPersistence';
import { useBrowserKeepalive } from '../hooks/useBrowserKeepalive';
import { useBrowserGroups } from '../hooks/useBrowserGroups';
import { useBrailleSpinner } from '../hooks/useBrailleSpinner';
import { useWorkspaceTargets } from '../hooks/useWorkspaceTargets';
import { useAgentActivity } from '../hooks/useAgentActivity';
import { useNotificationChannel } from '../hooks/useNotificationChannel';
import { useWorkspaceData } from '../hooks/useWorkspaceData';
import { useSidebarState } from '../hooks/useSidebarState';
import { useWindowActions } from '../hooks/useWindowActions';
import { useAddWindowModal } from '../hooks/useAddWindowModal';

import { useDragUpload } from '../hooks/useDragUpload';
import { useIsMobile } from '../hooks/useIsMobile';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { useTerminalTheme } from '../hooks/useTerminalTheme';
import { usePaneLayout } from '../hooks/usePaneLayout';
import { usePaneRects } from '../hooks/usePaneRects';
import { findPane, findPaneByTab, listPanes, closeTab as closeTabInLayoutTree, type PaneNode, type DropZone } from '../hooks/paneLayoutTree';
import { addBrowserToTaskLayout } from '../components/task/taskPaneLayout';
import type { BrowserOpenedPayload } from '../types/notification';
import WorkspaceSidebarContent from '../components/workspace/WorkspaceSidebarContent';
import ActiveWindowsSection from '../components/workspace/ActiveWindowsSection';
import WorkspaceLayout from '../components/workspace/WorkspaceLayout';
import AddWindowModal from '../components/workspace/AddWindowModal';
import ConfirmDialog from '../components/ConfirmDialog';
import ResourceWarningDialog, { type ResourceStatus } from '../components/ResourceWarningDialog';
import TabContentRenderer from '../components/workspace/TabContentRenderer';
import WorkspaceWelcome from '../components/workspace/WorkspaceWelcome';
import { SplitLayout, type PaneDrag } from '../components/workspace/SplitLayout';
import { resolveDisplayedTaskTerminal, selectTaskTerminal } from '../components/workspace/TaskPanel';

import type { SidebarMode, Task, Project } from './workspace/types';
import { ACTIVE_PROJECT_KEY, getProjectColorFallback } from './workspace/types';
import { GlobalFocusProvider, useGlobalFocus } from '../hooks/useGlobalFocus';

export default function Workspace() {
  return (
    <GlobalFocusProvider>
      <WorkspaceInner />
    </GlobalFocusProvider>
  );
}

function WorkspaceInner() {
  const { t } = useTranslation(['workspace', 'tasks']);
  const navigate = useNavigate();
  const location = useLocation();
  const brailleFrame = useBrailleSpinner();

  const wsMatch = matchWorkspacePath(location.pathname);
  const projectMatch = matchPath('/projects/:id', location.pathname);
  const urlId = wsMatch?.id || projectMatch?.params.id;
  const urlMode = wsMatch?.mode;

  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    if (urlId) return urlId;
    return localStorage.getItem(ACTIVE_PROJECT_KEY) || '';
  });

  const id = urlId || activeProjectId || undefined;

  const { setActiveProjectId: setThemeProjectId } = useTerminalTheme();

  useEffect(() => {
    if (urlId && urlId !== activeProjectId) {
      setActiveProjectId(urlId);
      localStorage.setItem(ACTIVE_PROJECT_KEY, urlId);
    }
  }, [urlId, activeProjectId]);

  useEffect(() => {
    setThemeProjectId(activeProjectId || null);
  }, [activeProjectId, setThemeProjectId]);

  const { tabs, activeTabId, setActiveTabId, connectPane: connectPaneRaw, closeTab, retargetTab, openFile: openFileRaw, openUnit: openUnitRaw, openTask: openTaskRaw, openTaskForm: openTaskFormRaw, openUnitForm, openSidekickForm, openIssue: openIssueRaw, openIssueList: openIssueListRaw, openServer: _openServerTab, openBrowser, updateBrowserActiveTab, openStorageFile: openStorageFileRaw, openDiff: openDiffRaw, reorderTab, openProjectTasks, openSettings: openSettingsRaw, togglePin } = useTabPersistence();

  const openServer = useCallback((serverName: string) => {
    navigate(paths.server(serverName, 'overview'));
  }, [navigate]);

  // useBrowserKeepalive takes a plain BrowserGroupRef[] (not PersistedTab[] directly) so
  // TaskPanel's own task-scoped `v-browser:` tabs can share the same hook — derive it here
  // with the same `[tabs]` dependency the hook itself used to key off of directly, so the
  // keepalive-resend cadence is unchanged (still re-sent on every tabs-array identity
  // change, not just ones that touch a browser tab).
  const browserGroupRefs = useMemo(
    () => tabs.filter((t): t is PersistedTab & { browserData: NonNullable<PersistedTab['browserData']> } => t.type === 'browser' && !!t.browserData)
      .map((t) => ({ serverName: t.browserData.serverName, pageId: t.browserData.pageId })),
    [tabs],
  );
  useBrowserKeepalive(browserGroupRefs);


  const sidebar = useSidebarState(id, urlMode, location.pathname, navigate);
  const { sidebarMode, switchSidebarMode, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, sidebarOpen, setSidebarOpen, selectedRepoId, setSelectedRepoId, handleResizeMouseDown, handleResizeDoubleClick } = sidebar;

  const data = useWorkspaceData(id, tabs, sidebarMode);
  const { project, allUnits, tasks, servers, sessionData, allProjects, allTasks, projectsLoaded, projectServers, selectedFileServer, setSelectedFileServer, refreshWorkspace } = data;

  const browserCapableServers = useMemo(
    () => servers.filter((s) => s.type === 'local' || s.type === 'agent').map((s) => s.name),
    [servers],
  );
  const browserGroups = useBrowserGroups(browserCapableServers);

  const taskWindows = useMemo(() => {
    const entries: Array<{ tmuxTarget: string; taskId: number; serverName: string }> = [];
    for (const t of allTasks) {
      if (!t.windows) continue;
      for (const w of t.windows) {
        entries.push({ tmuxTarget: w.tmuxTarget, taskId: t.id, serverName: w.serverName });
      }
    }
    return entries;
  }, [allTasks]);

  const projectSettings = useProjectSettings(parseInt(id || '0', 10), tabs, closeTab);

  const mobile = useIsMobile();
  const sidebarCollapsedEffective = sidebarCollapsed;
  const currentProjectId = parseInt(id || '0', 10);

  // Sidebar section clicks must both update the sidebar highlight (projectSettings.setSection)
  // and update the settings tab's persisted settingsSection so SettingsTabContent's effect
  // picks it up (see openSettingsRaw / TabContentRenderer's SettingsTabContent).
  const handleSidebarSettingsSection = useCallback((section: SettingsSection) => {
    projectSettings.setSection(section);
    if (project) {
      openSettingsRaw(currentProjectId, project.name, section);
    }
  }, [projectSettings, project, openSettingsRaw, currentProjectId]);

  const sidebarProjectSettings = { section: projectSettings.section, setSection: handleSidebarSettingsSection };

  const { menu: contextMenu, show: showContextMenu, showAt: showContextMenuAt, hide: hideContextMenu } = useContextMenu();

  const { showToast } = useToast();
  const confirm = useConfirm();

  useNotificationChannel({
    onBrowserOpened: useCallback((payload: BrowserOpenedPayload) => {
      const { serverName, groupId, taskId } = payload;
      if (taskId != null) {
        addBrowserToTaskLayout(taskId, serverName, groupId);
        const task = allTasks.find((t) => t.id === taskId);
        if (task) {
          openTaskRaw(taskId, task.title, task.projectId);
        }
      } else {
        const autoOpen = localStorage.getItem('browser-auto-open') === 'true';
        if (autoOpen) {
          openBrowser(serverName, groupId);
        } else {
          showToast(t('workspace:toast.browserTabOpened', { serverName }));
        }
      }
    }, [allTasks, openTaskRaw, openBrowser, showToast]),
  });

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.projectId && tab.projectId !== currentProjectId) {
      navigate(`/workspace/${tab.projectId}`);
    }
  }, [tabs, currentProjectId, navigate, setActiveTabId]);

  // Multi-pane split layout (Issue #397). `allTabIds` must be a stable
  // reference across renders that don't actually add/remove tabs, or
  // usePaneLayout's reconcile effect (which no-ops on an unchanged tab set)
  // would still fire pointlessly every render.
  const allTabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const layout = usePaneLayout('workspace-layout', allTabIds);
  const paneRects = usePaneRects();
  const [paneDrag, setPaneDrag] = useState<PaneDrag | null>(null);

  // Every existing "open a tab" call site funnels through useTabPersistence's
  // activeTabId (openTab -> setActiveTabId). Mirroring that into the layout
  // here is what wires all of them into the multi-pane tree without touching
  // each call site individually: an already-open tab is just re-activated in
  // its own pane; a brand new tab was already placed by usePaneLayout's own
  // reconcile effect (into the first pane) before this effect can run.
  useEffect(() => {
    if (!activeTabId) return;
    // activeTabId and the tab entities are persisted under separate
    // localStorage keys, so a legacy-normalization pass (or any other skew
    // between them) can leave activeTabId pointing at a tab that no longer
    // exists. Guard against inserting that ghost id into the pane tree —
    // nothing renders for it anyway, and useTabPersistence already owns
    // clearing/advancing activeTabId when a tab goes away.
    if (!tabs.some((t) => t.id === activeTabId)) return;
    layout.open(activeTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabs, layout.open]);

  // The "single active tab" concept used by focus/overlay resolution below is
  // replaced by "the focused pane's active tab" now that multiple tabs can be
  // visible at once. Falls back to activeTabId only when the focused pane
  // itself can't be resolved (e.g. before the layout has settled) — once a
  // pane IS resolved, its own activeTabId (including null for an
  // intentionally-empty focused pane) is authoritative, so focusing an empty
  // pane correctly clears focus/overlay resolution instead of leaving a stale
  // tab (e.g. a terminal in a different pane) as the target.
  const focusedActiveTabId = useMemo(() => {
    const pane = layout.state.focusedPaneId ? findPane(layout.state.root, layout.state.focusedPaneId) : null;
    return pane ? pane.activeTabId : activeTabId;
  }, [layout.state.root, layout.state.focusedPaneId, activeTabId]);

  // Pane-local tab selection: keeps the pane's own active tab and the
  // pane-focus in sync, mirrors the selection into useTabPersistence's
  // activeTabId (guarded so an already-current selection is a no-op and
  // doesn't re-trigger the open-sync effect above), and navigates to the
  // tab's own project when it differs from the currently-open one — every
  // caller that moves pane focus to a specific tab (tab-bar click, and the
  // content-area pointerdown-capture focus handler below) must go through
  // this so a cross-project tab's content is never shown against the wrong
  // project's `tasks`/`project`/`projectServers`.
  const selectPaneTab = useCallback((paneId: string, tabId: string) => {
    layout.setActive(paneId, tabId);
    layout.focusPane(paneId);
    if (activeTabId !== tabId) setActiveTabId(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.projectId && tab.projectId !== currentProjectId) {
      navigate(`/workspace/${tab.projectId}`);
    }
  }, [layout, activeTabId, setActiveTabId, tabs, currentProjectId, navigate]);

  const handlePaneSelectTab = selectPaneTab;

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
    // The dropped tab becomes active in its destination pane, which also
    // gains focus — keep useTabPersistence's activeTabId (mobile rendering,
    // opener tracking, task targeting) pointed at the same tab.
    if (activeTabId !== paneDrag.tabId) setActiveTabId(paneDrag.tabId);
    setPaneDrag(null);
  }, [paneDrag, layout, activeTabId, setActiveTabId]);

  // Pane-aware tab close: closing a pane's tab must hand focus to that
  // pane's own successor tab (or the pane usePaneLayout's close() falls back
  // to), not whatever the global flat-tab-list closeTab() would pick — that
  // could land on a tab in an entirely different pane, yanking focus away.
  // Mirrors usePaneLayout's own close() computation (same pure closeTab() +
  // focusedPaneId fallback) purely to read the resulting active tab
  // synchronously, since the hook's own state update is async.
  const handlePaneCloseTab = useCallback((paneId: string, tabId: string) => {
    const newRoot = closeTabInLayoutTree(layout.state.root, paneId, tabId);
    const newFocusedPaneId = layout.state.focusedPaneId && findPane(newRoot, layout.state.focusedPaneId)
      ? layout.state.focusedPaneId
      : listPanes(newRoot)[0].id;
    const nextActiveTabId = findPane(newRoot, newFocusedPaneId)?.activeTabId ?? null;

    layout.close(paneId, tabId);
    closeTab(tabId);
    if (nextActiveTabId && activeTabId !== nextActiveTabId) {
      setActiveTabId(nextActiveTabId);
    }
  }, [layout, closeTab, activeTabId, setActiveTabId]);

  // Single entry point for "close this tab by id" that every close affordance
  // (pane TabBar's ✕, the shared tab context menu's "Close tab" item, and
  // TabContentRenderer's own in-panel close buttons) should go through, so
  // none of them can bypass handlePaneCloseTab's pane-aware successor/focus
  // handling by routing through the flat closeTab() directly. Falls back to
  // the flat closeTab() only when the tab isn't tracked by any pane (should
  // not normally happen — every open tab is reconciled into the layout).
  const closeTabPaneAware = useCallback((tabId: string) => {
    const pane = findPaneByTab(layout.state.root, tabId);
    if (pane) {
      handlePaneCloseTab(pane.id, tabId);
    } else {
      closeTab(tabId);
    }
  }, [layout, handlePaneCloseTab, closeTab]);

  const connectPane = useCallback((serverName: string, target: string, projectId?: number) => {
    connectPaneRaw(serverName, target, projectId ?? currentProjectId);
    if (mobile) setSidebarOpen(false);
  }, [connectPaneRaw, mobile, currentProjectId, setSidebarOpen]);

  const { setOnOpenInTerminal, setOnOpenTask, setActiveTabId: setTargetsActiveTabId, setFocusedTarget } = useWorkspaceTargets();
  const { shouldShowActivity, shouldShowTaskActivity } = useAgentActivity();
  useEffect(() => { setTargetsActiveTabId(activeTabId); }, [activeTabId, setTargetsActiveTabId]);

  useEffect(() => {
    if (!focusedActiveTabId?.startsWith('terminal:')) return;
    const rest = focusedActiveTabId.slice('terminal:'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return;
    const serverName = rest.slice(0, slashIdx);
    const target = rest.slice(slashIdx + 1);
    setFocusedTarget(`${serverName}::${target}`);
    return () => setFocusedTarget(null);
  }, [focusedActiveTabId, setFocusedTarget]);
  useEffect(() => {
    setOnOpenInTerminal(connectPane);
    return () => setOnOpenInTerminal(null);
  }, [connectPane, setOnOpenInTerminal]);

  const { focus, setFocus } = useGlobalFocus();

  const resolveOverlayTarget = useCallback((): { serverName: string; tmuxTarget: string } | null => {
    if (focus.serverName && focus.tmuxTarget) {
      return { serverName: focus.serverName, tmuxTarget: focus.tmuxTarget };
    }
    if (focusedActiveTabId?.startsWith('terminal:')) {
      const rest = focusedActiveTabId.slice('terminal:'.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        return { serverName: rest.slice(0, slashIdx), tmuxTarget: rest.slice(slashIdx + 1) };
      }
    }
    const activeTab = tabs.find((t) => t.id === focusedActiveTabId);
    if (activeTab?.type === 'task' && activeTab.entityId) {
      const task = tasks.find((t) => t.id === activeTab.entityId) ?? allTasks.find((t) => t.id === activeTab.entityId);
      const displayed = resolveDisplayedTaskTerminal(activeTab.entityId, task?.windows ?? []);
      if (displayed) {
        return { serverName: displayed.serverName, tmuxTarget: displayed.target };
      }
    }
    return null;
  }, [focus.serverName, focus.tmuxTarget, focusedActiveTabId, tabs, tasks, allTasks]);

  const handleOverlaySendKey = useCallback(async (key: string) => {
    const target = resolveOverlayTarget();
    if (!target) {
      showToast(t('workspace:toast.noTerminalSelected'));
      return;
    }
    try {
      const res = await api<{ ok?: boolean; error?: string }>(
        `/servers/${target.serverName}/panes/${encodeURIComponent(target.tmuxTarget)}/send-keys`,
        { method: 'POST', body: JSON.stringify({ keys: [key] }) },
      );
      if (res?.error) showToast(t('workspace:toast.sendKeysFailed', { error: res.error }));
    } catch (e) {
      showToast(t('workspace:toast.sendKeysFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [resolveOverlayTarget, showToast]);

  const openFile = useCallback((serverName: string, filePath: string) => {
    openFileRaw(serverName, filePath, currentProjectId);
  }, [openFileRaw, currentProjectId]);

  const openDiff = useCallback((serverName: string, path: string, baseBranch?: string) => {
    openDiffRaw(serverName, path, baseBranch, currentProjectId);
    if (mobile) setSidebarOpen(false);
  }, [openDiffRaw, currentProjectId, mobile, setSidebarOpen]);

  const openTask = useCallback((taskId: number, title: string, fromOrProjectId?: 'global' | 'workspace' | number, from?: 'global' | 'workspace') => {
    const taskProjectId = allTasks.find((t) => t.id === taskId)?.projectId;
    if (typeof fromOrProjectId === 'number') {
      openTaskRaw(taskId, title, taskProjectId ?? fromOrProjectId, from);
    } else {
      openTaskRaw(taskId, title, taskProjectId ?? currentProjectId, fromOrProjectId);
    }
  }, [openTaskRaw, currentProjectId, allTasks]);

  useEffect(() => {
    setOnOpenTask((taskId) => openTask(taskId, t('tasks:detail.taskRef', { id: taskId })));
    return () => setOnOpenTask(null);
  }, [openTask, setOnOpenTask]);

  // Active Windows からの選択はタブを開くだけでなく、当該プロジェクトへフォーカスも移す（#346）
  const focusProjectById = useCallback((projectId?: number) => {
    if (projectId && projectId !== currentProjectId) {
      navigate(`/workspace/${projectId}`);
    }
  }, [currentProjectId, navigate]);

  const connectPaneFromActiveWindow = useCallback((serverName: string, target: string, projectId?: number) => {
    connectPane(serverName, target, projectId);
    focusProjectById(projectId);
  }, [connectPane, focusProjectById]);

  const openTaskFromActiveWindow = useCallback((taskId: number, title: string, projectId?: number) => {
    openTask(taskId, title, projectId);
    focusProjectById(allTasks.find((t) => t.id === taskId)?.projectId ?? projectId);
  }, [openTask, allTasks, focusProjectById]);

  const findTaskByTarget = useCallback((target: string) => {
    const parts = target.split(':');
    if (parts.length < 2) return null;
    const windowName = parts[1].split('.')[0];
    return tasks.find(t => t.tmuxWindow === windowName)
      ?? allTasks.find(t => t.tmuxWindow === windowName)
      ?? null;
  }, [tasks, allTasks]);

  useEffect(() => {
    if (!focusedActiveTabId) {
      setFocus({ serverName: null, tmuxTarget: null, taskId: null });
      return;
    }
    if (focusedActiveTabId.startsWith('terminal:')) {
      const rest = focusedActiveTabId.slice('terminal:'.length);
      const slashIdx = rest.indexOf('/');
      if (slashIdx > 0) {
        const serverName = rest.slice(0, slashIdx);
        const tmuxTarget = rest.slice(slashIdx + 1);
        const task = findTaskByTarget(tmuxTarget);
        setFocus({ serverName, tmuxTarget, taskId: task?.id ?? null });
        return;
      }
    }
    const activeTab = tabs.find((t) => t.id === focusedActiveTabId);
    if (activeTab?.type === 'task' && activeTab.entityId) {
      const task = tasks.find((t) => t.id === activeTab.entityId) ?? allTasks.find((t) => t.id === activeTab.entityId);
      const displayed = resolveDisplayedTaskTerminal(activeTab.entityId, task?.windows ?? []);
      setFocus({ serverName: displayed?.serverName ?? null, tmuxTarget: displayed?.target ?? null, taskId: activeTab.entityId });
      return;
    }
    setFocus({ serverName: null, tmuxTarget: null, taskId: null });
  }, [focusedActiveTabId, tabs, tasks, allTasks, setFocus, findTaskByTarget]);

  const openIssue = useCallback((repoId: number, owner: string, repo: string, issueNumber: number, title: string) => {
    openIssueRaw(repoId, owner, repo, issueNumber, title, currentProjectId);
  }, [openIssueRaw, currentProjectId]);

  const openTaskForm = useCallback((opts: Parameters<typeof openTaskFormRaw>[0]) => {
    openTaskFormRaw(opts);
    if (mobile) setSidebarOpen(false);
  }, [openTaskFormRaw, mobile, setSidebarOpen]);

  const handleOpenTask = useCallback((t: Task, from?: 'global' | 'workspace') => {
    openTask(t.id, t.title, from || 'workspace');
    if (mobile) setSidebarOpen(false);
  }, [openTask, mobile, setSidebarOpen]);

  const handleSwitchSidebarMode = useCallback((mode: SidebarMode) => {
    if (mode === 'settings' && project) {
      openSettingsRaw(currentProjectId, project.name);
    }
    switchSidebarMode(mode);
  }, [switchSidebarMode, openSettingsRaw, currentProjectId, project]);

  const handleSelectRepo = useCallback((repoId: number) => {
    setSelectedRepoId(repoId);
    const repo = (project?.repositories || []).find((r) => r.id === repoId);
    if (repo?.owner && repo.repoName) {
      openIssueListRaw(repo.id, repo.owner, repo.repoName, currentProjectId, repo.provider);
    }
    if (mobile) setSidebarOpen(false);
  }, [setSelectedRepoId, project, openIssueListRaw, currentProjectId, mobile, setSidebarOpen]);

  const handleSplitFromTarget = useCallback(async (serverName: string, target: string, direction: 'h' | 'v') => {
    const colonIdx = target.indexOf(':');
    if (colonIdx < 0) return;
    const sessionName = target.substring(0, colonIdx);
    const rest = target.substring(colonIdx + 1);
    const dotIdx = rest.indexOf('.');
    if (dotIdx < 0) return;
    const windowIndex = parseInt(rest.substring(0, dotIdx), 10);
    if (isNaN(windowIndex)) return;
    try {
      await api(`/servers/${serverName}/sessions/${sessionName}/windows/${windowIndex}/panes`, { method: 'POST', body: JSON.stringify({ direction }) });
      showToast(t(direction === 'h' ? 'workspace:pane.splitSuccessH' : 'workspace:pane.splitSuccessV'));
    } catch (e) {
      showToast(t('workspace:pane.splitFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [showToast]);


  useEffect(() => {
    if (!id) {
      api<Array<{ id: number }>>('/projects').then((projects) => {
        if (projects.length > 0) {
          const firstId = String(projects[0].id);
          setActiveProjectId(firstId);
          localStorage.setItem(ACTIVE_PROJECT_KEY, firstId);
        }
      }).catch(() => {});
    }
  }, [id]);

  useEffect(() => {
    const state = location.state as { openTaskId?: number; openTaskTitle?: string; from?: 'global' | 'workspace'; openTaskForm?: boolean } | null;
    if (state?.openTaskId) {
      openTask(state.openTaskId, state.openTaskTitle || t('tasks:detail.taskRef', { id: state.openTaskId }), state.from);
      navigate(location.pathname, { replace: true, state: {} });
    } else if (state?.openTaskForm) {
      openTaskForm({ mode: 'create', projectId: currentProjectId });
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, openTask, openTaskForm, navigate, location.pathname, sidebarMode, switchSidebarMode, currentProjectId]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const taskParam = params.get('task');
    if (!taskParam) return;
    const taskId = parseInt(taskParam, 10);
    if (isNaN(taskId)) return;
    openTask(taskId, t('tasks:detail.taskRef', { id: taskId }), 'global');
    navigate(location.pathname, { replace: true });
  }, [location.search]);

  const handleFileSelect = useCallback((serverName: string, filePath: string) => {
    openFile(serverName, filePath);
    if (mobile) setSidebarOpen(false);
  }, [openFile, mobile, setSidebarOpen]);

  const [executeResourceWarning, setExecuteResourceWarning] = useState<{ resources: ResourceStatus; retry: () => void } | null>(null);

  const executeTask = useCallback(async function perform(taskId: number, unitId: number | null, force = false) {
    if (!unitId) { showToast(t('workspace:toast.noUnit')); return; }
    if (!force) {
      const ok = await confirm({ title: t('workspace:toast.startExecution'), message: t('workspace:toast.startConfirm') });
      if (!ok) return;
    }
    const res = await api<{ error?: string; resources?: ResourceStatus }>(`/units/${unitId}/execute`, { method: 'POST', body: JSON.stringify({ taskId, force }) });
    if (res.error === 'insufficient_resources' && res.resources) {
      setExecuteResourceWarning({
        resources: res.resources,
        retry: () => { setExecuteResourceWarning(null); void perform(taskId, unitId, true); },
      });
      return;
    }
    if (res.error) return showToast(res.error);
    refreshWorkspace();
  }, [refreshWorkspace, showToast, confirm]);

  const stopTask = useCallback(async (unitId: number | null) => {
    if (!unitId) return;
    await api(`/units/${unitId}/stop`, { method: 'POST' });
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleAddWindowToProject = useCallback(async (projectId: number, serverName: string, tmuxTarget: string) => {
    await api(`/projects/${projectId}/windows`, {
      method: 'POST',
      body: JSON.stringify({ server_name: serverName, tmux_target: tmuxTarget }),
    });
    refreshWorkspace();
  }, [refreshWorkspace]);

  const windowActions = useWindowActions(id, refreshWorkspace, {
    // Pane-aware close: the tab context menu's "Close tab" item (used by both
    // the pane TabBar via buildPaneTabMenuItems' base and mobile's single
    // TabBar) must go through the same pane-successor/focus handling as the
    // pane TabBar's own ✕ button, not the flat closeTab().
    showContextMenu, showContextMenuAt, findTaskByTarget, openTask, tabs, closeTab: closeTabPaneAware, refreshSessions: data.refreshSessions, togglePin, connectPane,
  });

  const handleWindowAddedToTask = useCallback(async (
    taskId: number,
    serverName: string,
    tmuxTarget: string,
    label: string,
    activate: boolean,
    extra?: { windowType?: string; workerType?: string; workerModel?: string; workingDirectory?: string },
  ) => {
    try {
      const body: Record<string, unknown> = { server_name: serverName, tmux_target: tmuxTarget, label: label || null };
      if (extra?.windowType) body['window_type'] = extra.windowType;
      if (extra?.workerType) body['worker_type'] = extra.workerType;
      if (extra?.workerModel) body['worker_model'] = extra.workerModel;
      if (extra?.workingDirectory) body['working_directory'] = extra.workingDirectory;
      await api(`/tasks/${taskId}/windows`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch { /* project window was still added */ }
    if (activate) {
      selectTaskTerminal(taskId, { serverName, target: tmuxTarget });
    }
  }, []);

  const addWindowModal = useAddWindowModal(id, project, servers, projectServers, refreshWorkspace, data.refreshSessions, connectPane, handleWindowAddedToTask);

  // TaskPanel's "add window" action must register the window under the task's own project,
  // not the workspace's currently-open project (they differ when a task tab from another
  // project is open). Fetch that project's data on demand and pass it as an override.
  const handleOpenAddWindow = useCallback(async (forTask?: boolean, taskProjectId?: number, taskId?: number) => {
    if (forTask && taskProjectId != null && String(taskProjectId) !== id) {
      try {
        const [taskProject, taskProjectServers] = await Promise.all([
          api<Project>(`/projects/${taskProjectId}`),
          api<{ serverName: string; workingDirectory?: string }[]>(`/projects/${taskProjectId}/servers`),
        ]);
        addWindowModal.openAddWindow(true, {
          projectId: String(taskProjectId),
          project: taskProject,
          projectServers: Array.isArray(taskProjectServers) ? taskProjectServers : [],
        }, taskId);
        return;
      } catch {
        showToast(t('workspace:toast.taskProjectFailed'));
        return;
      }
    }
    addWindowModal.openAddWindow(forTask ?? false, undefined, taskId);
  }, [id, addWindowModal, showToast]);

  const { globalDrag, dragHandlers } = useDragUpload(currentProjectId || null, sidebarMode, showToast, mobile);

  const getTerminalTabLabel = useCallback((serverName: string, target: string): string => {
    const m = target.match(/^(.+):(\d+)\.(\d+)$/);
    if (!m) return target;
    const [, sessionName, winIdx, paneIdx] = m;
    const srvSessions = sessionData[serverName] || [];
    const session = srvSessions.find((s) => s.name === sessionName);
    let winName = '', paneTitle = '';
    if (session) {
      const win = session.windows.find((w) => w.index === parseInt(winIdx, 10));
      if (win) {
        winName = win.name;
        const pane = win.panes.find((p) => p.index === parseInt(paneIdx, 10));
        if (pane) paneTitle = pane.title && pane.title !== pane.command ? pane.title : '';
      }
    }
    const projWin = project?.windows.find((w) => {
      const parts = w.tmuxTarget.split(':');
      return w.serverName === serverName && parts[0] === sessionName && (parts[1] == null || parseInt(parts[1], 10) === parseInt(winIdx, 10));
    });
    const displayName = paneTitle || projWin?.label || winName || sessionName;
    const hasManyPanes = (session?.windows.find((w) => w.index === parseInt(winIdx, 10))?.panes.length ?? 0) > 1;
    const paneSuffix = hasManyPanes ? `.${paneIdx}` : '';
    return `${sessionName} / ${displayName}${paneSuffix}`;
  }, [sessionData, project]);

  const buildTabItem = useCallback((tab: PersistedTab): TabItem => {
    const iconName: IconName | null = tab.type === 'terminal' ? 'terminal'
      : tab.type === 'file' ? 'files'
      : tab.type === 'unit' ? 'units'
      : tab.type === 'task' ? 'tasks'
      : tab.type === 'task-form' ? 'edit'
      : tab.type === 'unit-form' ? 'units'
      : tab.type === 'sidekick-form' ? 'sidekicks'
      : tab.type === 'issue' ? 'repos'
      : tab.type === 'issue-list' ? 'repos'
      : tab.type === 'project-tasks' ? 'tasks'
      : tab.type === 'server' ? 'servers'
      : tab.type === 'settings' ? 'settings'
      : tab.type === 'storage-file' ? (tab.storageFileData?.originalName?.toLowerCase().endsWith('.pdf') ? 'files' : 'image')
      : tab.type === 'diff' ? 'kanban'
      : tab.type === 'browser' ? 'browser'
      : null;
    const icon = iconName
      ? <span style={{ display: 'inline-flex', verticalAlign: '-2px' }}><Icon name={iconName} size={14} /></span>
      : '•';
    const displayLabel = tab.type === 'terminal' && tab.serverName && tab.target
      ? getTerminalTabLabel(tab.serverName, tab.target)
      : tab.label;
    const running = tab.type === 'terminal' && tab.serverName && tab.target
      ? shouldShowActivity(tab.serverName, tab.target)
      : tab.type === 'task' && tab.entityId !== undefined
        ? shouldShowTaskActivity(tab.entityId)
        : false;
    return {
      id: tab.id,
      label: displayLabel,
      icon,
      pinned: tab.pinned,
      className: running ? 'tab-active-comet' : undefined,
      projectColor: tab.projectId
        ? (allProjects.find(p => p.id === tab.projectId)?.color || getProjectColorFallback(tab.projectId))
        : undefined,
      extra: running ? <span className="tab-braille-spinner" style={{ fontSize: 'var(--font-xs)', lineHeight: 1 }}>{brailleFrame}</span> : undefined,
    };
  }, [getTerminalTabLabel, shouldShowActivity, shouldShowTaskActivity, allProjects, brailleFrame]);

  // These pane operations (from the tab context menu / trailing buttons)
  // make `tabId`/the pane's own active tab active in a (possibly different)
  // pane and move focus there — keep useTabPersistence's activeTabId synced
  // to match, guarded so an already-current value is a no-op.
  const syncActiveTabId = useCallback((tabId: string | null) => {
    if (tabId && activeTabId !== tabId) setActiveTabId(tabId);
  }, [activeTabId, setActiveTabId]);

  const buildPaneTabMenuItems = useCallback((pane: PaneNode, tabId: string): ContextMenuItem[] => {
    const base = windowActions.getTabMenuItems(tabId);
    const panesCount = listPanes(layout.state.root).length;
    const extra: ContextMenuItem[] = [];
    if (panesCount > 1) {
      extra.push({ label: t('workspace:pane.nextPane'), icon: <Icon name="pane-next" size={16} />, onClick: () => { layout.moveToNext(pane.id, tabId); syncActiveTabId(tabId); } });
    }
    extra.push(
      { label: t('workspace:pane.splitRightAndShow'), icon: <Icon name="split-h" size={16} />, onClick: () => { layout.split(pane.id, 'right', tabId, pane.id); syncActiveTabId(tabId); } },
      { label: t('workspace:pane.splitBelowAndShow'), icon: <Icon name="split-v" size={16} />, onClick: () => { layout.split(pane.id, 'bottom', tabId, pane.id); syncActiveTabId(tabId); } },
    );
    if (extra.length === 0) return base;
    return [...base, { label: '', separator: true, onClick: () => {} }, ...extra];
  }, [windowActions, layout, syncActiveTabId]);

  const renderPaneTrailing = useCallback((pane: PaneNode) => {
    const panesCount = listPanes(layout.state.root).length;
    const canMerge = panesCount > 1 && pane.tabIds.length > 0;
    const canCloseEmpty = panesCount > 1 && pane.tabIds.length === 0;
    return (
      <>
        <IconButton size="sm" title={t('workspace:pane.splitRight')} onClick={() => layout.split(pane.id, 'right', null, null)}><Icon name="split-h" size={14} /></IconButton>
        <IconButton size="sm" title={t('workspace:pane.splitBelow')} onClick={() => layout.split(pane.id, 'bottom', null, null)}><Icon name="split-v" size={14} /></IconButton>
        {canMerge && (
          <IconButton size="sm" title={t('workspace:pane.merge')} onClick={() => { layout.merge(pane.id); syncActiveTabId(pane.activeTabId); }}><Icon name="merge" size={14} /></IconButton>
        )}
        {canCloseEmpty && (
          <IconButton size="sm" title={t('workspace:pane.close')} onClick={() => layout.merge(pane.id)}><Icon name="pane-close" size={14} /></IconButton>
        )}
      </>
    );
  }, [layout, syncActiveTabId]);

  const renderPaneBar = useCallback((pane: PaneNode) => {
    const paneTabItems = pane.tabIds
      .map((tabId) => tabs.find((t) => t.id === tabId))
      .filter((t): t is PersistedTab => !!t)
      .map(buildTabItem);
    return (
      <TabBar
        tabs={paneTabItems}
        activeId={pane.activeTabId}
        onSelect={(tabId) => handlePaneSelectTab(pane.id, tabId)}
        onClose={(tabId) => handlePaneCloseTab(pane.id, tabId)}
        draggable
        onTabDragStart={(tabId) => setPaneDrag({ tabId, fromPaneId: pane.id })}
        onTabDragEnd={() => setPaneDrag(null)}
        onTabContextMenu={(e, tabId) => showContextMenu(e, buildPaneTabMenuItems(pane, tabId))}
        onTabLongPress={(x, y, tabId) => showContextMenuAt(x, y, buildPaneTabMenuItems(pane, tabId))}
        trailing={renderPaneTrailing(pane)}
      />
    );
  }, [tabs, buildTabItem, handlePaneSelectTab, handlePaneCloseTab, buildPaneTabMenuItems, showContextMenu, showContextMenuAt, renderPaneTrailing]);

  const renderPaneEmpty = useCallback(() => (
    <EmptyState title={t('workspace:pane.dragHint')} />
  ), []);

  if (!project) {
    if (projectsLoaded && allProjects.length === 0) {
      return <WorkspaceWelcome onCreateProject={() => navigate(paths.projectNew())} />;
    }
    return <LoadingState />;
  }

  const sidebarContent = (
    <WorkspaceSidebarContent
      sidebarMode={sidebarMode}
      project={project}
      sessionData={sessionData}
      activeTabId={activeTabId}
      tasks={tasks}
      openTask={openTask}
      openProjectTasks={openProjectTasks}
      onCreateTask={() => openTaskForm({ mode: 'create', projectId: currentProjectId })}
      onOpenTaskWindow={(taskId, title, terminal) => {
        selectTaskTerminal(taskId, terminal);
        openTask(taskId, title);
      }}
      onOpenTaskBrowser={(taskId, title, browser) => {
        addBrowserToTaskLayout(taskId, browser.serverName, browser.groupId);
        openTask(taskId, title);
      }}
      projectServers={projectServers}
      selectedFileServer={selectedFileServer}
      onSelectFileServer={setSelectedFileServer}
      selectedRepoId={selectedRepoId}
      onSelectRepo={handleSelectRepo}
      connectPane={connectPane}
      onOpenAddWindow={addWindowModal.openAddWindow}
      showWindowContextMenu={windowActions.showWindowContextMenu}
      onSwitchSidebarMode={handleSwitchSidebarMode}
      onFileSelect={handleFileSelect}
      onRefresh={refreshWorkspace}
      mobile={mobile}
      onCloseMobileSidebar={() => setSidebarOpen(false)}
      tabs={tabs}
      closeTab={closeTab}
      connectPaneRaw={connectPaneRaw}
      openServer={openServer}
      openBrowser={openBrowser}
      browserGroups={browserGroups}
      openStorageFileRaw={openStorageFileRaw}
      projectSettings={sidebarProjectSettings}
      onOpenDiff={openDiff}
      respawningWindowIds={windowActions.respawningWindowIds}
      taskWindows={taskWindows}
      allProjects={allProjects}
      onAddWindowToProject={handleAddWindowToProject}
    />
  );

  const activeWindowsSection = (
    <ActiveWindowsSection
      connectPane={connectPaneFromActiveWindow}
      openTask={openTaskFromActiveWindow}
      taskWindows={taskWindows}
    />
  );

  const modals = (
    <>
      <AddWindowModal
        open={addWindowModal.addWindowOpen}
        onClose={() => addWindowModal.setAddWindowOpen(false)}
        loading={addWindowModal.addWindowLoading}
        onSubmit={() => addWindowModal.handleAddWindow()}
        awMode={addWindowModal.awMode}
        setAwMode={addWindowModal.setAwMode}
        awServer={addWindowModal.awServer}
        setAwServer={addWindowModal.setAwServer}
        awTarget={addWindowModal.awTarget}
        setAwTarget={addWindowModal.setAwTarget}
        awLabel={addWindowModal.awLabel}
        setAwLabel={addWindowModal.setAwLabel}
        awSessionData={addWindowModal.awSessionData}
        setAwSessionData={addWindowModal.setAwSessionData}
        awSelectedSession={addWindowModal.awSelectedSession}
        setAwSelectedSession={addWindowModal.setAwSelectedSession}
        awNewSession={addWindowModal.awNewSession}
        awNewWindowName={addWindowModal.awNewWindowName}
        setAwNewWindowName={addWindowModal.setAwNewWindowName}
        awNewCommand={addWindowModal.awNewCommand}
        setAwNewCommand={addWindowModal.setAwNewCommand}
        awWorkDir={addWindowModal.awWorkDir}
        setAwWorkDir={addWindowModal.setAwWorkDir}
        awAgent={addWindowModal.awAgent}
        onAgentChange={addWindowModal.handleAgentChange}
        awAgentModel={addWindowModal.awAgentModel}
        setAwAgentModel={addWindowModal.setAwAgentModel}
        awWorkerModels={addWindowModal.awWorkerModels}
        agentPresets={addWindowModal.agentPresets}
        agentPresetsLoading={addWindowModal.agentPresetsLoading}
        agentPresetsError={addWindowModal.agentPresetsError}
        servers={servers}
        projectServers={addWindowModal.awEffectiveProjectServers ?? projectServers}
        project={addWindowModal.awEffectiveProject ?? project}
      />
      <ResourceWarningDialog
        open={addWindowModal.awResourceWarning !== null}
        title={t('workspace:resourceWarning.title')}
        resources={addWindowModal.awResourceWarning?.resources ?? null}
        actionLabel={t('workspace:resourceWarning.openAnyway')}
        onCancel={() => addWindowModal.setAwResourceWarning(null)}
        onForce={() => addWindowModal.awResourceWarning?.retry()}
      />
      <ResourceWarningDialog
        open={executeResourceWarning !== null}
        title={t('workspace:resourceWarning.cannotStart')}
        resources={executeResourceWarning?.resources ?? null}
        actionLabel={t('workspace:resourceWarning.executeAnyway')}
        cancelHint={t('workspace:resourceWarning.cancelHint')}
        onCancel={() => setExecuteResourceWarning(null)}
        onForce={() => executeResourceWarning?.retry()}
      />
      <ResourceWarningDialog
        open={windowActions.respawnResourceWarning !== null}
        title={t('workspace:resourceWarning.title')}
        resources={windowActions.respawnResourceWarning?.resources ?? null}
        actionLabel={t('workspace:resourceWarning.restartAnyway')}
        onCancel={() => windowActions.setRespawnResourceWarning(null)}
        onForce={() => windowActions.respawnResourceWarning?.retry()}
      />
    </>
  );

  const confirmDialogNode = (
    <ConfirmDialog
      open={windowActions.confirmDialog !== null}
      title={windowActions.confirmDialog?.title ?? ''}
      message={windowActions.confirmDialog?.message ?? ''}
      onConfirm={windowActions.confirmDialog?.onConfirm ?? (() => {})}
      onCancel={() => windowActions.setConfirmDialog(null)}
      loading={windowActions.windowActionLoading}
    />
  );

  return (
    <WorkspaceLayout
      mobile={mobile}
      sidebarMode={sidebarMode}
      switchSidebarMode={handleSwitchSidebarMode}
      sidebarCollapsed={sidebarCollapsed}
      setSidebarCollapsed={setSidebarCollapsed}
      sidebarCollapsedEffective={sidebarCollapsedEffective}
      sidebarWidth={sidebarWidth}
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      handleResizeMouseDown={handleResizeMouseDown}
      handleResizeDoubleClick={handleResizeDoubleClick}
      project={project}
      allProjects={allProjects}
      sidebarContent={sidebarContent}
      activeWindowsSection={activeWindowsSection}
      globalDrag={globalDrag}
      dragHandlers={dragHandlers}
      contextMenu={contextMenu ? <ContextMenu menu={contextMenu} onClose={hideContextMenu} /> : null}
      confirmDialog={confirmDialogNode}
      modals={modals}
      onSendKey={handleOverlaySendKey}
      connectPane={connectPaneFromActiveWindow}
      openTask={openTaskFromActiveWindow}
      taskWindows={taskWindows}
    >
        {mobile ? (
          <>
            <TabBar
              tabs={tabs.map(buildTabItem)}
              activeId={activeTabId}
              onSelect={handleSelectTab}
              onClose={closeTab}
              onReorder={reorderTab}
              draggable
              onTabContextMenu={windowActions.handleTabContextMenu}
              onTabLongPress={windowActions.handleTabLongPress}
            />

            <div style={{ flex: 1, position: 'relative', background: 'var(--ws-content)' }}>
              {tabs.length === 0 && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-dim)', fontSize: 'var(--font-base)', flexDirection: 'column', gap: 8, padding: 20, textAlign: 'center', background: 'var(--bg)' }}>
                  <div>{t('workspace:pane.selectHint')}</div>
                </div>
              )}

              {tabs.map((tab) => renderTabContent(tab, { position: 'absolute', inset: 0 }, tab.id === activeTabId, closeTab))}
            </div>
          </>
        ) : (
          // Multi-pane split layout (Issue #397). With a single pane (the
          // default, and the state every pre-existing workspace loads into
          // since usePaneLayout seeds one pane containing every tab), this
          // renders exactly one TabBar sized to the full content area — same
          // as the pre-split-layout markup above — and every tab's overlay
          // rect equals that pane's full body rect, so `isVisible` reduces to
          // "this tab is the pane's (only) active tab", i.e. the same
          // single-active-tab semantics as before.
          <div ref={paneRects.containerRef} style={{ flex: 1, position: 'relative', background: 'var(--ws-content)', overflow: 'hidden' }}>
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

            {tabs.map((tab) => {
              const pane = findPaneByTab(layout.state.root, tab.id);
              const rect = pane ? paneRects.rects[pane.id] : undefined;
              const isVisible = !!pane && pane.activeTabId === tab.id;
              // Multiple task tabs can be simultaneously visible across panes; only the
              // one in the *focused* pane may write to the global focus singleton (see
              // TaskPanel's `isPaneFocused` prop doc) — a visible-but-unfocused pane's
              // own background polling must not steal focus from the focused pane.
              const isPaneFocused = !!pane && pane.id === layout.state.focusedPaneId;
              const positionStyle: React.CSSProperties = rect
                ? { position: 'absolute', top: rect.top, left: rect.left, width: rect.width, height: rect.height }
                : { position: 'absolute', top: 0, left: 0, width: 0, height: 0, visibility: 'hidden' };
              return renderTabContent(tab, { ...positionStyle, overflow: 'hidden' }, isVisible, closeTabPaneAware, isPaneFocused);
            })}
          </div>
        )}
    </WorkspaceLayout>
  );

  // Tab content overlays render as SplitLayout's following siblings (so they
  // paint above its "chrome"), which has consequences every wrapper must
  // account for:
  // - during a pane-tab drag, the overlay would otherwise intercept
  //   dragover/drop before it reaches SplitLayoutPane's handlers underneath,
  //   so center/edge drop zones never trigger.
  // - every tab sharing a pane overlays the same rect, so a hidden tab's
  //   wrapper (later in DOM order within that rect) would otherwise still be
  //   hit-tested and steal clicks meant for the visible one underneath — and
  //   its own capture handler would then activate the *hidden* tab.
  // pointerEvents is therefore 'auto' only for the visible tab outside a
  // drag; every other wrapper (hidden, or any wrapper mid-drag) is 'none',
  // which also means the capture handler below only ever fires for the
  // tab that's actually visible.
  // `isPaneFocused` is omitted by the mobile call site (single-pane concept doesn't
  // apply there) — TabContentRenderer/TaskPanel both default an omitted value to
  // "focused", preserving mobile's existing single-view behavior untouched.
  function renderTabContent(tab: PersistedTab, wrapperStyle: React.CSSProperties, isVisible: boolean, closeTabFn: (tabId: string) => void, isPaneFocused?: boolean) {
    const interactive = isVisible && !paneDrag;
    const style: React.CSSProperties = { ...wrapperStyle, pointerEvents: interactive ? 'auto' : 'none' };
    const handlePointerDownCapture = interactive
      ? () => {
        const pane = findPaneByTab(layout.state.root, tab.id);
        if (!pane) return;
        selectPaneTab(pane.id, tab.id);
      }
      : undefined;
    return (
      <div key={tab.id} style={style} onPointerDownCapture={handlePointerDownCapture}>
        <TabContentRenderer
          tab={tab}
          isPaneFocused={isPaneFocused}
          isVisible={isVisible}
          tabs={tabs}
          allUnits={allUnits}
          tasks={tasks}
          allTasks={allTasks}
          allProjects={allProjects}
          project={project}
          projectServers={projectServers}
          sessionData={sessionData}
          currentProjectId={currentProjectId}
          handleOpenTask={handleOpenTask}
          closeTab={closeTabFn}
          retargetTab={retargetTab}
          executeTask={executeTask}
          stopTask={stopTask}
          refreshWorkspace={refreshWorkspace}
          connectPane={connectPane}
          openTask={openTask}
          openTaskRaw={openTaskRaw}
          openTaskForm={openTaskForm}
          openUnitRaw={openUnitRaw}
          openUnitForm={openUnitForm}
          openSidekickForm={openSidekickForm}
          switchSidebarMode={switchSidebarMode}
          onOpenAddWindow={handleOpenAddWindow}
          onSplitPane={handleSplitFromTarget}
          onPaneDisconnect={data.refreshSessions}
          openIssue={openIssue}
          openProjectTasks={openProjectTasks}
          updateBrowserActiveTab={updateBrowserActiveTab}
        />
      </div>
    );
  }
}
