import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { useNavigate } from 'react-router-dom';
import type { SidebarMode } from '../../pages/workspace/types';
import { paths } from '../../paths';
import { MobileNavSheet } from './MobileNavSheet';
import ContextMenu, { useContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu';
import LocalMenu from './LocalMenu';
import LocalMenuPopover from './LocalMenuPopover';
import { ProjectAvatar } from '../ui/ProjectAvatar';

interface ProjectItem {
  id: number;
  name: string;
  icon?: string;
  color?: string;
}

function buildProjectMenuItems(
  allProjects: ProjectItem[],
  currentProject: { id: number; name: string } | null,
  onSelect: (id: number) => void,
  extraItems: ContextMenuItem[] = [],
): ContextMenuItem[] {
  const projectItems = allProjects.map((p) => ({
    label: p.name,
    selected: p.id === currentProject?.id,
    icon: p.icon && p.icon.startsWith('data:') ? (
      <img src={p.icon} alt="" style={{ width: 16, height: 16, borderRadius: 'var(--radius-sm)', objectFit: 'cover' }} />
    ) : p.icon ? p.icon : (
      <span style={{
        width: 16, height: 16, borderRadius: 'var(--radius-sm)', display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', fontSize: 'var(--font-2xs)', fontWeight: 600,
        background: p.color || 'var(--bg)',
        color: p.color ? '#fff' : 'var(--text-dim)', // lint-allow: hex - white text on solid project-color fill; no on-color token yet
        border: !p.color ? '1px solid var(--border)' : 'none',
      }}>{p.name.charAt(0).toUpperCase()}</span>
    ),
    onClick: () => onSelect(p.id),
  }));
  return extraItems.length > 0
    ? [...projectItems, { label: '', separator: true, onClick: () => {} }, ...extraItems]
    : projectItems;
}

interface WorkspaceLayoutProps {
  mobile: boolean;
  sidebarMode: SidebarMode;
  switchSidebarMode: (mode: SidebarMode) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  sidebarCollapsedEffective: boolean;
  sidebarWidth: number;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  handleResizeMouseDown: (e: React.MouseEvent) => void;
  handleResizeDoubleClick: () => void;
  project: { id: number; name: string } | null;
  allProjects: ProjectItem[];
  sidebarContent: React.ReactNode;
  activeWindowsSection?: React.ReactNode;
  children: React.ReactNode;
  globalDrag: boolean;
  dragHandlers: Record<string, any>;
  contextMenu: React.ReactNode;
  confirmDialog: React.ReactNode;
  modals: React.ReactNode;
  connectPane?: (serverName: string, target: string, projectId?: number) => void;
  openTask?: (taskId: number, title: string, projectId?: number) => void;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
  /** SP の M1 メニュー「オブジェクト」行に表示する総件数（Issue #69 T1）。 */
  objectsCount?: number;
}

export default function WorkspaceLayout({
  mobile,
  sidebarMode,
  switchSidebarMode,
  sidebarCollapsed,
  setSidebarCollapsed,
  sidebarCollapsedEffective,
  sidebarWidth,
  sidebarOpen,
  setSidebarOpen,
  handleResizeMouseDown,
  handleResizeDoubleClick,
  project,
  allProjects,
  sidebarContent,
  activeWindowsSection,
  children,
  globalDrag,
  dragHandlers,
  contextMenu,
  confirmDialog,
  modals,
  connectPane,
  openTask,
  taskWindows,
  objectsCount,
}: WorkspaceLayoutProps) {
  const { t } = useTranslation(['workspace', 'common', 'projects']);
  const navigate = useNavigate();
  const currentProjectItem = allProjects.find((p) => p.id === project?.id) ?? null;
  const projectMenu = useContextMenu();

  const handleProjectSelect = (id: number) => {
    navigate(paths.workspace(id));
  };

  // Toggle behavior: while the menu is open, stop mousedown/touchstart from reaching
  // useClickOutside's document listeners (which would close it before click fires),
  // then close it in onClick instead of re-showing.
  const buildProjectActions = (closeSidebar: boolean): ContextMenuItem[] => [
    {
      label: t('projects:search.newProject'),
      icon: <Icon name="plus" size={16} />,
      onClick: () => { if (closeSidebar) setSidebarOpen(false); navigate(paths.projectNew()); },
    },
    {
      label: t('projects:search.allProjects'),
      icon: <Icon name="projects" size={16} />,
      onClick: () => { if (closeSidebar) setSidebarOpen(false); navigate(paths.projects()); },
    },
  ];

  const projectMenuTriggerProps = (onSelect: (id: number) => void, extraItems: ContextMenuItem[] = []) => ({
    onMouseDown: (e: React.MouseEvent) => { if (projectMenu.menu) e.stopPropagation(); },
    onTouchStart: (e: React.TouchEvent) => { if (projectMenu.menu) e.stopPropagation(); },
    onClick: (e: React.MouseEvent) => {
      if (projectMenu.menu) projectMenu.hide();
      else projectMenu.show(e, buildProjectMenuItems(allProjects, project, onSelect, extraItems));
    },
  });

  const [popoverMode, setPopoverMode] = useState<SidebarMode | null>(null);
  const popoverAnchorY = useRef(0);

  const handleCollapsedModeClick = useCallback(
    (mode: SidebarMode, e?: React.MouseEvent) => {
      if (popoverMode === mode) {
        setPopoverMode(null);
        return;
      }
      if (e) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        popoverAnchorY.current = rect.top;
      }
      switchSidebarMode(mode);
      setPopoverMode(mode);
    },
    [popoverMode, switchSidebarMode],
  );

  return (
    <div style={{ display: 'flex', height: '100%', position: 'relative' }} {...dragHandlers}>
      {globalDrag && !mobile && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 200,
          background: 'var(--accent-a08)', border: '3px dashed var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none', borderRadius: 0,
        }}>
          <span style={{ background: 'var(--bg-card)', padding: '12px 24px', borderRadius: 'var(--radius-md)', fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--accent)', border: '1px solid var(--accent)' }}>
            {t('workspace:dropZone.uploadToStorage')}
          </span>
        </div>
      )}


      {!mobile && (() => {
        if (sidebarCollapsedEffective) {
          return (
            <>
              <LocalMenu
                collapsed
                sidebarMode={sidebarMode}
                onModeClick={(mode, e) => handleCollapsedModeClick(mode, e)}
                onExpand={() => { setSidebarCollapsed(false); setPopoverMode(null); }}
                connectPane={connectPane}
                openTask={openTask}
                taskWindows={taskWindows}
                projectAvatar={
                  <button
                    {...projectMenuTriggerProps(handleProjectSelect, buildProjectActions(false))}
                    title={project?.name || ''}
                    style={{
                      width: 28,
                      height: 28,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'none',
                      border: 'none',
                      borderRadius: 'var(--radius-md)',
                      padding: 0,
                      margin: '2px 0 4px',
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                    className="icon-btn"
                  >
                    <ProjectAvatar project={currentProjectItem} size={28} />
                  </button>
                }
              />
              <LocalMenuPopover
                open={popoverMode !== null}
                onClose={() => setPopoverMode(null)}
                anchorY={popoverAnchorY.current}
              >
                {popoverMode !== null && (
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px',
                      borderBottom: '1px solid var(--border)', flexShrink: 0,
                    }}>
                      <Icon name={popoverMode} size={16} />
                      <span style={{ fontSize: 'var(--font-md)', fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>
                        {popoverMode === 'settings' ? t('workspace:sidebar.projectSettings') : t(`workspace:menu.${popoverMode === 'repos' ? 'repositories' : popoverMode}`)}
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        onClick={() => {
                          switchSidebarMode(popoverMode);
                          setSidebarCollapsed(false);
                          setPopoverMode(null);
                        }}
                        title={t('common:navigation.expandSidebar')}
                        className="icon-btn"
                        style={{
                          border: 'none', cursor: 'pointer',
                          color: 'var(--text-dim)', fontSize: 'var(--font-sm)', padding: '2px 6px',
                        }}
                      >
                        <Icon name="panel-left-open" size={16} />
                      </button>
                    </div>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
                      {sidebarContent}
                    </div>
                  </div>
                )}
              </LocalMenuPopover>
            </>
          );
        }

        return (
          <div className="ws-surface" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 51, background: 'var(--ws-surface)' }}>
            <div className="ws-surface" style={{ display: 'flex', alignItems: 'center', padding: '0 8px 0 12px', minHeight: 48, background: 'transparent', flexShrink: 0, position: 'relative' }}>
              <button
                {...projectMenuTriggerProps(handleProjectSelect, buildProjectActions(false))}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0, margin: 0,
                  color: 'var(--text)', textAlign: 'left',
                }}
              >
                <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project?.name || ''}</span>
                <span style={{ color: 'var(--text-dim)', flexShrink: 0, display: 'inline-flex' }}><Icon name="chevron-down" size={14} rotate={projectMenu.menu ? 180 : 0} /></span>
              </button>
              <button onClick={() => setSidebarCollapsed(true)} title={t('common:navigation.collapseSidebar')}
                className="icon-btn"
                style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', flexShrink: 0 }}>
                <Icon name="panel-left-close" size={16} />
              </button>
            </div>
            <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
              <LocalMenu
                collapsed={false}
                sidebarMode={sidebarMode}
                onModeClick={switchSidebarMode}
              />
              <div style={{
                width: sidebarWidth, minWidth: sidebarWidth,
                display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--ws-surface-card)',
                borderRadius: 'var(--panel-radius) 0 0 var(--panel-radius)', boxShadow: 'inset 0 1px 0 var(--edge-hi), var(--panel-shadow)',
              }} className="ws-surface">
                {sidebarContent}
                {activeWindowsSection}
              </div>
            </div>
          </div>
        );
      })()}

      {mobile && (
        <MobileNavSheet
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          project={project}
          allProjects={allProjects}
          onSelectProject={handleProjectSelect}
          sidebarMode={sidebarMode}
          switchSidebarMode={switchSidebarMode}
          sidebarContent={sidebarContent}
          objectsCount={objectsCount ?? 0}
          connectPane={connectPane}
          openTask={openTask}
          taskWindows={taskWindows}
        />
      )}

      {!mobile && !sidebarCollapsedEffective && (
        <div
          className="resize-handle"
          onMouseDown={handleResizeMouseDown}
          onDoubleClick={handleResizeDoubleClick}
        >
          <div className="resize-handle-inner" />
        </div>
      )}

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        {children}
      </div>

      {modals}

      {projectMenu.menu && <ContextMenu menu={projectMenu.menu} onClose={projectMenu.hide} />}

      {contextMenu}

      {confirmDialog}
    </div>
  );
}
