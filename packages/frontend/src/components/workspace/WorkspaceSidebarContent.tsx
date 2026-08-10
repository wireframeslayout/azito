import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SidebarMode, Project, Session, Window, Task } from '../../pages/workspace/types';
import type { PersistedTab } from '../../hooks/useTabPersistence';
import type { BrowserGroupInfo } from '../../hooks/useBrowserGroups';
import type { ContextMenuItem } from '../ContextMenu';
import FileExplorer from '../FileExplorer';
import { FileSearchPanel } from '../files/FileSearchPanel';
import { RootSwitcher, type WorktreeItem } from '../files/RootSwitcher';
import { FileSidebarHeader } from '../files/FileSidebarHeader';
import { PathBreadcrumb } from '../files/PathBreadcrumb';
import { Notice } from '../ui/Notice';
import RepoSidebar from '../RepoSidebar';
import StoragePanel from '../StoragePanel';
import { SettingsSidebar, type SettingsSection } from '../ProjectSettings';
import ObjectsSidebar from './ObjectsSidebar';
import TasksSidebar from './TasksSidebar';

interface WorkspaceSidebarContentProps {
  sidebarMode: SidebarMode;
  project: Project | null;
  sessionData: Record<string, Session[]>;
  activeTabId: string | null;
  tasks: Task[];
  openTask: (taskId: number, title: string) => void;
  openProjectTasks: (projectId: number, projectName: string) => void;
  onCreateTask?: () => void;
  onOpenTaskWindow?: (taskId: number, taskTitle: string, terminal: { serverName: string; target: string }) => void;
  onOpenTaskBrowser?: (taskId: number, taskTitle: string, browser: { serverName: string; groupId: string }) => void;
  projectServers: { serverName: string; workingDirectory?: string }[];
  selectedFileServer: string;
  onSelectFileServer: (server: string) => void;
  selectedRepoId: number | null;
  onSelectRepo: (id: number) => void;
  connectPane: (serverName: string, target: string) => void;
  onOpenAddWindow: () => void;
  onOpenQuickAdd: (serverName: string, agentType: 'claude' | 'codex' | 'terminal') => void;
  /** クイック追加ボタンの押下可否判定に使う。起動コマンドを実際に供給する useAddWindowModal 側の取得状態（Workspace.tsx 経由） */
  agentDefsLoading: boolean;
  agentDefsError: string | null;
  showWindowContextMenu: (e: React.MouseEvent, w: Window, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void;
  onSwitchSidebarMode: (mode: SidebarMode) => void;
  onFileSelect: (serverName: string, filePath: string, line?: number) => void;
  onRefresh: () => void;
  mobile: boolean;
  onCloseMobileSidebar: () => void;
  tabs: PersistedTab[];
  closeTab: (tabId: string) => void;
  connectPaneRaw: (serverName: string, target: string) => void;
  openServer: (name: string) => void;
  openBrowser: (serverName: string, groupId?: string) => void;
  browserGroups?: Record<string, BrowserGroupInfo[]>;
  browserErrors?: Record<string, string>;
  refreshBrowserGroups?: () => void;
  /** true once the browser-capable server set has completed its first status fetch (see useBrowserGroups) */
  browserGroupsLoaded?: boolean;
  browserCapableServerNames: string[];
  showContextMenu: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
  showContextMenuAt: (x: number, y: number, items: ContextMenuItem[]) => void;
  onCapturePanes: (windowId: number) => void;
  onStopOperation: (unitId: number | null, taskId: number) => void;
  openStorageFileRaw: (projectId: number, filename: string, originalName: string, size: number) => void;
  projectSettings: { section: SettingsSection; setSection: (s: SettingsSection) => void };
  onOpenDiff: (serverName: string, path: string) => void;
  respawningWindowIds?: Set<number>;
  taskWindows?: Array<{ tmuxTarget: string; taskId: number; serverName: string }>;
  allProjects?: Array<{ id: number; name: string; windows?: Array<{ serverName: string; tmuxTarget: string }> }>;
  onAddWindowToProject?: (projectId: number, serverName: string, tmuxTarget: string) => void;
}

export default function WorkspaceSidebarContent({
  sidebarMode,
  project,
  sessionData,
  activeTabId,
  tasks,
  openTask,
  openProjectTasks,
  onCreateTask,
  onOpenTaskWindow,
  onOpenTaskBrowser,
  projectServers,
  selectedFileServer,
  onSelectFileServer,
  selectedRepoId,
  onSelectRepo,
  connectPane,
  onOpenAddWindow,
  onOpenQuickAdd,
  agentDefsLoading,
  agentDefsError,
  showWindowContextMenu,
  onSwitchSidebarMode,
  onFileSelect,
  onRefresh,
  mobile,
  onCloseMobileSidebar,
  tabs,
  closeTab,
  openBrowser,
  browserGroups,
  browserErrors,
  refreshBrowserGroups,
  browserGroupsLoaded,
  browserCapableServerNames,
  showContextMenu,
  showContextMenuAt,
  onCapturePanes,
  onStopOperation,
  openStorageFileRaw,
  projectSettings,
  onOpenDiff,
  respawningWindowIds,
  taskWindows,
}: WorkspaceSidebarContentProps) {
  const { t } = useTranslation('workspace');
  const { t: tf } = useTranslation('files');
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | null>(null);
  const [filesView, setFilesView] = useState<'tree' | 'search'>('tree');
  const [currentWorktree, setCurrentWorktree] = useState<WorktreeItem | null>(null);
  const fileRefreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSelectedWorktreePath(null);
  }, [project?.id, selectedFileServer]);

  const handleRefresh = useCallback(() => {
    fileRefreshRef.current?.();
  }, []);

  const handleRefreshRef = useCallback((fn: () => void) => {
    fileRefreshRef.current = fn;
  }, []);

  return (
    <>
      {sidebarMode === 'windows' && project && (
        <ObjectsSidebar
          project={project}
          sessionData={sessionData}
          activeTabId={activeTabId}
          mobile={mobile}
          projectServers={projectServers}
          connectPane={connectPane}
          showWindowContextMenu={showWindowContextMenu}
          onOpenAddWindow={onOpenAddWindow}
          onOpenQuickAdd={onOpenQuickAdd}
          agentDefsLoading={agentDefsLoading}
          agentDefsError={agentDefsError}
          onCloseMobileSidebar={onCloseMobileSidebar}
          respawningWindowIds={respawningWindowIds}
          taskWindows={taskWindows}
          tasks={tasks}
          browserGroups={browserGroups ?? {}}
          browserErrors={browserErrors ?? {}}
          refreshBrowserGroups={refreshBrowserGroups ?? (() => {})}
          browserGroupsLoaded={browserGroupsLoaded ?? true}
          browserCapableServerNames={browserCapableServerNames}
          showContextMenu={showContextMenu}
          showContextMenuAt={showContextMenuAt}
          onCapturePanes={onCapturePanes}
          onStopOperation={onStopOperation}
          tabs={tabs}
          closeTab={closeTab}
          openBrowser={openBrowser}
          openTask={openTask}
          onOpenTaskWindow={onOpenTaskWindow}
        />
      )}
      {sidebarMode === 'tasks' && project && (
        <TasksSidebar
          tasks={tasks}
          onOpenTask={(taskId, title) => {
            openTask(taskId, title);
            if (mobile) onCloseMobileSidebar();
          }}
          onOpenAllTasks={() => {
            openProjectTasks(project.id, project.name);
            if (mobile) onCloseMobileSidebar();
          }}
          onCreateTask={() => {
            onCreateTask?.();
            if (mobile) onCloseMobileSidebar();
          }}
          onOpenTaskWindow={(taskId, title, terminal) => {
            onOpenTaskWindow?.(taskId, title, terminal);
            if (mobile) onCloseMobileSidebar();
          }}
          onOpenTaskBrowser={(taskId, title, browser) => {
            onOpenTaskBrowser?.(taskId, title, browser);
            if (mobile) onCloseMobileSidebar();
          }}
        />
      )}
      {sidebarMode === 'files' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {(() => {
            const ps = projectServers.find((s) => s.serverName === selectedFileServer);
            const rootPath = ps?.workingDirectory;
            if (!rootPath) {
              return (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>
                  <p>{projectServers.length === 0 ? t('sidebar.noServerConfigured') : t('sidebar.noWorkingDir')}</p>
                  <button onClick={() => onSwitchSidebarMode('settings')} style={{ fontSize: 'var(--font-md)', marginTop: 8, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                    {t('sidebar.projectSettings')}
                  </button>
                </div>
              );
            }
            const effectiveRoot = selectedWorktreePath ?? rootPath;
            return (
              <>
                <FileSidebarHeader
                  onSearch={() => setFilesView(filesView === 'search' ? 'tree' : 'search')}
                  onDiff={() => { onOpenDiff(selectedFileServer, effectiveRoot); if (mobile) onCloseMobileSidebar(); }}
                  onRefresh={handleRefresh}
                  searchActive={filesView === 'search'}
                  serverName={projectServers.length > 1 ? selectedFileServer : undefined}
                  serverCount={projectServers.length}
                  allServerNames={projectServers.map((s) => s.serverName)}
                  onSelectServer={onSelectFileServer}
                />
                {project && (
                  <RootSwitcher
                    serverName={selectedFileServer}
                    projectId={project.id}
                    selectedPath={selectedWorktreePath}
                    onSelect={setSelectedWorktreePath}
                    onWorktreeChange={setCurrentWorktree}
                  />
                )}
                <PathBreadcrumb path={effectiveRoot} />
                {currentWorktree?.orphaned && (
                  <div style={{ padding: '0 12px 4px', flexShrink: 0 }}>
                    <Notice tone="warning">{tf('rootSwitcher.orphanedNotice')}</Notice>
                  </div>
                )}
                {filesView === 'search' && project ? (
                  <FileSearchPanel
                    serverName={selectedFileServer}
                    projectId={project.id}
                    root={effectiveRoot}
                    onOpenHit={(path, line) => {
                      onFileSelect(selectedFileServer, path, line);
                      if (mobile) onCloseMobileSidebar();
                    }}
                    onClose={() => setFilesView('tree')}
                  />
                ) : (
                  <FileExplorer
                    serverName={selectedFileServer}
                    rootPath={effectiveRoot}
                    projectId={project?.id}
                    onFileSelect={onFileSelect}
                    onRefreshRef={handleRefreshRef}
                  />
                )}
              </>
            );
          })()}
        </div>
      )}
      {sidebarMode === 'repos' && project && (
        <RepoSidebar projectId={project.id} repositories={project.repositories || []} selectedRepoId={selectedRepoId}
          onSelectRepo={(repoId) => { onSelectRepo(repoId); if (mobile) onCloseMobileSidebar(); }} onRefresh={onRefresh} />
      )}
      {sidebarMode === 'storage' && project && (
        <StoragePanel projectId={project.id} activeTabId={activeTabId} onFilePreview={(f) => {
          const fn = f.key.split('/').pop() || '';
          openStorageFileRaw(project.id, fn, f.originalName, f.size);
          if (mobile) onCloseMobileSidebar();
        }} />
      )}
      {sidebarMode === 'settings' && (
        <SettingsSidebar section={projectSettings.section} setSection={projectSettings.setSection} />
      )}
    </>
  );
}
