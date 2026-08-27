import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { paths } from '../../paths';
import { TerminalContainer } from '../TerminalContainer';
import { FilePreviewPanel } from '../FileExplorer';
import StorageFilePreview from '../StorageFilePreview';
import UnitPanel from './UnitPanel';
import TaskPanel from './TaskPanel';
import IssueDetailPanel from '../IssueDetailPanel';
import IssueListPanel from '../IssueListPanel';
import TaskFormView from '../TaskFormView';
import UnitFormView from '../UnitFormView';
import SidekickFormView from '../SidekickFormView';
import type { TaskFormValue } from '../../lib/taskForm';
import TaskListView from '../TaskListView';
import { SettingsContent, useProjectSettings } from '../ProjectSettings';
import { DiffViewer } from '../diff';
import BrowserView from '../BrowserView';
import { Button } from '../ui';
import type { PersistedTab } from '../../hooks/useTabPersistence';
import type { Task, Unit, Project, Session, SidebarMode } from '../../pages/workspace/types';
import { isSupportedProvider } from '../../lib/gitProvider';

interface TabContentRendererProps {
  tab: PersistedTab;
  isVisible: boolean;
  /**
   * Whether this tab's pane is the focused one (desktop multi-pane split only —
   * Issue #397). Pass-through prop for TaskPanel's `isPaneFocused` (see its own doc);
   * irrelevant to every other tab type. Omit (mobile's single-view path) to default to
   * focused/true.
   */
  isPaneFocused?: boolean;
  tabs: PersistedTab[];
  allUnits: Unit[];
  tasks: Task[];
  allTasks: Task[];
  allProjects: Array<{ id: number; name: string }>;
  project: Project | null;
  projectServers: { serverName: string; workingDirectory?: string }[];
  sessionData: Record<string, Session[]>;
  currentProjectId: number;
  handleOpenTask: (t: Task, from?: 'global' | 'workspace') => void;
  closeTab: (tabId: string) => void;
  retargetTab?: (oldTabId: string, serverName: string, newTarget: string) => void;
  executeTask: (taskId: number, unitId: number | null) => void;
  stopTask: (unitId: number | null, taskId: number) => void;
  refreshWorkspace: () => void;
  connectPane: (serverName: string, target: string) => void;
  openTask: (taskId: number, title: string, from?: 'global' | 'workspace') => void;
  openTaskRaw: (taskId: number, title: string, projectId?: number, from?: 'global' | 'workspace') => void;
  openTaskForm: (opts: { mode: 'create' | 'edit'; taskId?: number; projectId?: number; presetTitle?: string; presetDescription?: string; presetSource?: { source: string; sourceRef: string } }) => void;
  openUnitRaw: (unitId: number, name: string, projectId?: number) => void;
  openUnitForm: (opts: { mode: 'create' | 'edit'; unitId?: number }) => void;
  openSidekickForm: (opts: { mode: 'create' | 'edit'; sidekickName?: string }) => void;
  switchSidebarMode: (mode: SidebarMode) => void;
  onOpenAddWindow?: (forTask?: boolean, taskProjectId?: number, taskId?: number) => void;
  onSplitPane?: (serverName: string, target: string, direction: 'h' | 'v') => void;
  onPaneDisconnect?: () => void;
  openIssue?: (repoId: number, owner: string, repo: string, issueNumber: number, title: string) => void;
  openProjectTasks?: (projectId: number, projectName: string) => void;
  updateBrowserActiveTab?: (tabId: string, chromiumTabId: string) => void;
  openFile?: (serverName: string, filePath: string, projectId?: number) => void;
  setTabDirty?: (tabId: string, dirty: boolean) => void;
  refreshBrowserGroups?: () => void;
  /** SP タスク詳細 ⋯ フルサイズメニューの「タブ操作 › ピン止め」（Issue #69 S8）— TaskPanel へ
   * 素通しするだけ。 */
  togglePin?: (tabId: string) => void;
}

export default function TabContentRenderer({
  tab,
  isVisible,
  isPaneFocused,
  tabs,
  allUnits,
  tasks,
  allTasks,
  allProjects,
  project,
  projectServers,
  sessionData,
  currentProjectId,
  handleOpenTask,
  closeTab,
  retargetTab,
  executeTask,
  stopTask,
  refreshWorkspace,
  connectPane,
  openTask,
  openTaskRaw,
  openTaskForm,
  openUnitRaw,
  openUnitForm,
  openSidekickForm,
  switchSidebarMode,
  onOpenAddWindow,
  onSplitPane,
  onPaneDisconnect,
  openIssue,
  openProjectTasks,
  updateBrowserActiveTab,
  openFile,
  setTabDirty,
  refreshBrowserGroups,
  togglePin,
}: TabContentRendererProps) {
  const { t } = useTranslation(['tasks', 'workspace', 'units']);
  const navigate = useNavigate();

  // "Back to list" idiom shared with TaskPanel's onBack: activate/open the
  // corresponding list tab and keep the detail/form tab open (the tab's ✕
  // still goes through closeTab's opener-restore logic).
  // Stable identity across re-renders (deps are tab.id, which doesn't change
  // for a given TabContentRenderer instance — each tab keeps its own mounted
  // instance keyed by tab.id in Workspace.tsx — and updateBrowserActiveTab,
  // itself a useCallback with empty deps). An inline arrow function here
  // would get a new identity every render, which BrowserView's
  // onActiveTabChange effect uses as a dep — churning it would re-run that
  // effect (and whatever it triggers, e.g. keepalive) far more than intended.
  const handleBrowserActiveTabChange = useCallback((chromiumTabId: string) => {
    updateBrowserActiveTab?.(tab.id, chromiumTabId);
  }, [tab.id, updateBrowserActiveTab]);

  const backToTasksList = () => {
    const proj = tab.projectId ? allProjects.find((p) => p.id === tab.projectId) : null;
    if (proj && openProjectTasks) {
      openProjectTasks(proj.id, proj.name);
    }
  };
  const isTerminal = tab.type === 'terminal' && tab.serverName && tab.target;
  if (isTerminal && !isVisible) return null;
  return (
    <div
      data-overlay-scope="workspace"
      data-tab-id={tab.id}
      // `inert` (React 19 supports the boolean HTML attribute) is a defense-in-depth
      // layer on top of visibility/pointer-events: those are inherited CSS properties
      // that a descendant can explicitly override back to visible/auto (exactly what
      // TaskPanel's own internal tab overlay used to do — see TaskPanel.tsx), silently
      // re-enabling hit-testing/paint for a tab that's supposed to be hidden. `inert`
      // structurally disables focus/pointer/AT interaction for the whole subtree
      // regardless of any inline style a descendant sets, so it can't be reintroduced.
      inert={!isVisible}
      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', visibility: isVisible ? 'visible' : 'hidden', pointerEvents: isVisible ? 'auto' : 'none' }}>
      {isTerminal && (
        <TerminalContainer
          serverName={tab.serverName!}
          target={tab.target!}
          projectId={tab.projectId}
          project={project}
          allTasks={allTasks}
          sessions={sessionData[tab.serverName!]}
          onWindowChanged={refreshWorkspace}
          onSplitPane={onSplitPane ? (dir) => onSplitPane(tab.serverName!, tab.target!, dir) : undefined}
          onOpenTask={openTask}
          onDisconnect={onPaneDisconnect}
          onCloseTab={() => closeTab(tab.id)}
          onRetargetTab={retargetTab ? (sn, nt) => retargetTab(tab.id, sn, nt) : undefined}
          reconnectKey={tab.reconnectKey}
        />
      )}
      {tab.type === 'file' && tab.serverName && tab.filePath && (
        <FilePreviewPanel
          serverName={tab.serverName}
          filePath={tab.filePath}
          projectId={tab.projectId}
          initialLine={tab.line}
          onDirtyChange={setTabDirty ? (dirty) => setTabDirty(tab.id, dirty) : undefined}
        />
      )}
      {tab.type === 'storage-file' && tab.storageFileData && (
        <StorageFilePreview
          projectId={tab.storageFileData.projectId}
          filename={tab.storageFileData.filename}
          originalName={tab.storageFileData.originalName}
          size={tab.storageFileData.size}
        />
      )}
      {tab.type === 'unit' && tab.entityId != null && (
        <UnitPanel
          unitId={tab.entityId}
          allUnits={allUnits}
          onOpenTask={handleOpenTask}
          onBack={() => navigate(paths.units())}
          connectPane={connectPane}
        />
      )}
      {tab.type === 'task' && tab.entityId != null && (
        <TaskPanel
          taskId={tab.entityId}
          isVisible={isVisible}
          isPaneFocused={isPaneFocused}
          allUnits={allUnits}
          tasks={tasks}
          allTasks={allTasks}
          projects={allProjects}
          currentProject={project}
          sessionData={sessionData}
          executeTask={executeTask}
          stopTask={(unitId) => stopTask(unitId, tab.entityId!)}
          onRefresh={refreshWorkspace}
          projectServers={projectServers}
          onOpenFile={openFile ? (serverName, filePath) => openFile(serverName, filePath, tab.projectId) : undefined}
          onBack={() => {
            const proj = tab.projectId ? allProjects.find((p) => p.id === tab.projectId) : null;
            if (proj && openProjectTasks) {
              openProjectTasks(proj.id, proj.name);
            } else {
              closeTab(tab.id);
              switchSidebarMode('tasks');
            }
          }}
          onDelete={(taskId) => {
            closeTab(`task:${taskId}`);
            const proj = tab.projectId ? allProjects.find((p) => p.id === tab.projectId) : null;
            if (proj && openProjectTasks) {
              openProjectTasks(proj.id, proj.name);
            }
          }}
          onEdit={(taskId) => openTaskForm({ mode: 'edit', taskId, projectId: tab.projectId })}
          onOpenAddWindow={onOpenAddWindow}
          onSplitPane={onSplitPane}
          onOpenTask={openTask}
          tabs={tabs}
          closeTab={closeTab}
          togglePin={togglePin}
          onBrowserPageReady={refreshBrowserGroups}
        />
      )}
      {tab.type === 'issue' && tab.issueData && tab.projectId && (
        <IssueDetailPanel
          projectId={tab.projectId}
          repoId={tab.issueData.repoId}
          owner={tab.issueData.owner}
          repo={tab.issueData.repo}
          issueNumber={tab.issueData.number}
          onImportAsTask={(issue) => {
            openTaskForm({
              mode: 'create',
              projectId: tab.projectId,
              presetTitle: issue.title,
              presetDescription: issue.body || '',
              presetSource: { source: 'github', sourceRef: `${tab.issueData!.owner}/${tab.issueData!.repo}#${issue.number}` },
            });
          }}
          linkedTask={(() => {
            const ref = `${tab.issueData.owner}/${tab.issueData.repo}#${tab.issueData.number}`;
            const t = tasks.find((tk) => tk.sourceRef === ref);
            return t ? { id: t.id, title: t.title } : null;
          })()}
          onOpenTask={(taskId, title) => handleOpenTask({ id: taskId, title } as Task, 'workspace')}
        />
      )}
      {tab.type === 'task-form' && tab.taskFormData && (() => {
        const tfd = tab.taskFormData;
        const editTask = tfd.mode === 'edit' && tfd.taskId ? tasks.find((t) => t.id === tfd.taskId) : undefined;
        const initialForm: Partial<TaskFormValue> = tfd.mode === 'edit' && editTask ? {
          title: editTask.title,
          description: editTask.description || '',
          status: editTask.status,
          serverName: editTask.serverName || '',
          unitId: editTask.unitId ? String(editTask.unitId) : '',
          priority: String(editTask.priority),
          tmuxWindow: editTask.tmuxWindow || '',
          baseBranch: editTask.baseBranch || '',
          targetBranch: editTask.targetBranch || '',
          skipPr: editTask.skipPr ?? false,
          workingDirectory: editTask.workingDirectory || '',
          workingBranch: editTask.branch || '',
          overrideSubagents: !!(editTask.reviewSubagent || editTask.implementSubagent),
          reviewSubagent: editTask.reviewSubagent ? { enabled: editTask.reviewSubagent.enabled, provider: editTask.reviewSubagent.provider, model: editTask.reviewSubagent.model } : null,
          implementSubagent: editTask.implementSubagent ? { enabled: editTask.implementSubagent.enabled, provider: editTask.implementSubagent.provider, model: editTask.implementSubagent.model } : null,
          overrideSleepAfterPush: editTask.sleepAfterPush != null,
          sleepAfterPush: editTask.sleepAfterPush ?? false,
          source: editTask.source && editTask.sourceRef ? { source: editTask.source, sourceRef: editTask.sourceRef } : null,
        } : {
          ...(tfd.presetTitle ? { title: tfd.presetTitle } : {}),
          ...(tfd.presetDescription ? { description: tfd.presetDescription } : {}),
          ...(tfd.presetSource ? { source: tfd.presetSource } : {}),
        };
        const formProjectId = tfd.projectId || currentProjectId;
        const projectRepos = formProjectId === currentProjectId
          ? (project?.repositories || [])
          : [];
        const defaultUnitId = formProjectId === currentProjectId
          ? (project?.defaultUnitId ?? null)
          : null;
        return (
          <TaskFormView
            mode={tfd.mode}
            taskId={tfd.taskId}
            initial={initialForm}
            projects={tfd.projectId ? undefined : allProjects.map((p) => ({ id: p.id, name: p.name }))}
            units={allUnits}
            defaultUnitId={defaultUnitId}
            repositories={projectRepos}
            projectId={formProjectId}
            projectServers={projectServers.map((ps) => ({ serverName: ps.serverName, workingDirectory: ps.workingDirectory ?? null }))}
            onSaved={() => {
              closeTab(tab.id);
              refreshWorkspace();
              backToTasksList();
            }}
            onCancel={() => {
              closeTab(tab.id);
              if (tfd.mode === 'edit' && tfd.taskId) {
                openTask(tfd.taskId, initialForm.title || t('tasks:detail.taskRef', { id: tfd.taskId }), 'workspace');
              } else {
                switchSidebarMode('tasks');
              }
            }}
            backLabel={t('tasks:sidebar.title')}
            onBack={backToTasksList}
          />
        );
      })()}
      {tab.type === 'project-tasks' && (
        <TaskListView
          tasks={tasks}
          projects={allProjects}
          units={allUnits}
          showProjectColumn={false}
          onTaskClick={(t) => handleOpenTask(t as Task, 'workspace')}
          onExecute={executeTask}
          onStop={(taskId) => {
            const t = tasks.find((x) => x.id === taskId);
            if (t) stopTask(t.unitId, t.id);
          }}
          headerRight={
            <Button variant="primary" size="sm" onClick={() => openTaskForm({ mode: 'create', projectId: currentProjectId })}>{t('tasks:actions.newTask')}</Button>
          }
        />
      )}
      {tab.type === 'diff' && tab.diffData && (
        <DiffViewer
          serverName={tab.diffData.serverName}
          path={tab.diffData.path}
          baseBranch={tab.diffData.baseBranch}
          onOpenFile={openFile ? (relPath) => {
            const base = tab.diffData!.path.endsWith('/') ? tab.diffData!.path : tab.diffData!.path + '/';
            openFile(tab.diffData!.serverName, base + relPath, tab.projectId);
          } : undefined}
        />
      )}
      {tab.type === 'browser' && tab.browserData && (
        <BrowserView
          serverName={tab.browserData.serverName}
          groupId={tab.browserData.pageId ?? 'default'}
          initialTabId={tab.browserData.lastActiveTabId}
          onActiveTabChange={handleBrowserActiveTabChange}
          onPageReady={refreshBrowserGroups}
        />
      )}
      {tab.type === 'server' && tab.serverName && (
        <div style={{ padding: 'var(--space-4)', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
          {t('workspace:tabContent.serverDetailMoved')}
        </div>
      )}
      {tab.type === 'settings' && tab.projectId && (
        <SettingsTabContent projectId={tab.projectId} tabs={[]} closeTab={closeTab} initialSection={tab.settingsSection} />
      )}
      {tab.type === 'unit-form' && tab.unitFormData && (
        <UnitFormView
          mode={tab.unitFormData.mode}
          unitId={tab.unitFormData.unitId}
          onSaved={() => {
            closeTab(tab.id);
            refreshWorkspace();
            navigate(paths.units());
          }}
          onCancel={() => closeTab(tab.id)}
          backLabel={t('units:backLabel')}
          onBack={() => navigate(paths.units())}
        />
      )}
      {tab.type === 'sidekick-form' && tab.sidekickFormData && (
        <SidekickFormView
          mode={tab.sidekickFormData.mode}
          sidekickName={tab.sidekickFormData.sidekickName}
          onSaved={() => {
            closeTab(tab.id);
            refreshWorkspace();
            navigate(paths.sidekicks());
          }}
          onCancel={() => closeTab(tab.id)}
          backLabel="Sidekicks"
          onBack={() => navigate(paths.sidekicks())}
        />
      )}
      {tab.type === 'issue-list' && tab.issueListData && tab.projectId && (
        <IssueListPanel
          projectId={tab.projectId}
          repository={{ id: tab.issueListData.repoId, url: '', owner: tab.issueListData.owner, repoName: tab.issueListData.repo, provider: tab.issueListData.provider }}
          onOpenIssue={(issue) => openIssue?.(tab.issueListData!.repoId, tab.issueListData!.owner, tab.issueListData!.repo, issue.number, issue.title)}
          onImportIssue={(issue) => {
            const d = tab.issueListData!;
            openTaskForm({
              mode: 'create',
              projectId: tab.projectId,
              presetTitle: issue.title,
              presetDescription: issue.body || '',
              presetSource: { source: isSupportedProvider(d.provider) ? d.provider : 'github', sourceRef: `${d.owner}/${d.repo}#${issue.number}` },
            });
          }}
          linkedTasksByRef={new Map(tasks.filter((t) => t.sourceRef && t.source && t.source !== 'local').map((t) => [t.sourceRef!, { id: t.id, title: t.title }]))}
          onOpenTask={(taskId, title) => handleOpenTask({ id: taskId, title } as Task, 'workspace')}
        />
      )}
    </div>
  );
}

function SettingsTabContent({ projectId, tabs, closeTab, initialSection }: { projectId: number; tabs: PersistedTab[]; closeTab: (id: string) => void; initialSection?: string }) {
  const settings = useProjectSettings(projectId, tabs, closeTab);
  React.useEffect(() => {
    if (initialSection) settings.setSection(initialSection as any);
  }, [initialSection]);
  return <SettingsContent settings={settings} />;
}
