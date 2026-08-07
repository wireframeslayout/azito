import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SidebarMode, Project, Session, Window, Task } from '../../pages/workspace/types';
import type { PersistedTab } from '../../hooks/useTabPersistence';
import type { BrowserGroupInfo } from '../../hooks/useBrowserGroups';
import type { ContextMenuItem } from '../ContextMenu';
import FileExplorer from '../FileExplorer';
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
  onFileSelect: (serverName: string, filePath: string) => void;
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
          {projectServers.length > 1 && (
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <select value={selectedFileServer} onChange={(e) => onSelectFileServer(e.target.value)}
                style={{ width: '100%', padding: '6px 8px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', outline: 'none' }}>
                {projectServers.map((ps) => (
                  <option key={ps.serverName} value={ps.serverName}>
                    {ps.serverName}{ps.workingDirectory ? ` (${ps.workingDirectory})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
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
            return (
              <>
                <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
                  <button
                    onClick={() => { onOpenDiff(selectedFileServer, rootPath); if (mobile) onCloseMobileSidebar(); }}
                    style={{
                      width: '100%',
                      padding: '5px 10px',
                      fontSize: 'var(--font-sm)',
                      color: 'var(--accent)',
                      background: 'var(--accent-a08)',
                      border: '1px solid var(--accent-a15)',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      fontWeight: 500,
                    }}
                  >
                    {t('sidebar.gitDiff')}
                  </button>
                </div>
                <FileExplorer serverName={selectedFileServer} rootPath={rootPath} onFileSelect={onFileSelect} />
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
