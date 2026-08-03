import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { useNavigate } from 'react-router-dom';
import type { SidebarMode } from '../../pages/workspace/types';
import { paths } from '../../paths';
import { MobileMenuBar } from './MobileMenuBar';
import ContextMenu, { useContextMenu } from '../ContextMenu';
import type { ContextMenuItem } from '../ContextMenu';
import LocalMenu, { SIDEBAR_ICONS } from './LocalMenu';
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
): ContextMenuItem[] {
  return allProjects.map((p) => ({
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
  onSendKey?: (key: string) => void;
  connectPane?: (serverName: string, target: string, projectId?: number) => void;
  openTask?: (taskId: number, title: string, projectId?: number) => void;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
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
  onSendKey,
  connectPane,
  openTask,
  taskWindows,
}: WorkspaceLayoutProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const navigate = useNavigate();
  const currentProjectItem = allProjects.find((p) => p.id === project?.id) ?? null;
  const projectMenu = useContextMenu();

  const handleProjectSelect = (id: number) => {
    navigate(paths.workspace(id));
  };

  const handleMobileProjectSelect = (id: number) => {
    setSidebarOpen(false);
    navigate(paths.workspace(id));
  };

  const handleMobileMenuOpenMode = (mode: SidebarMode) => {
    switchSidebarMode(mode);
    setSidebarOpen(true);
  };

  // Toggle behavior: while the menu is open, stop mousedown/touchstart from reaching
  // useClickOutside's document listeners (which would close it before click fires),
  // then close it in onClick instead of re-showing.
  const projectMenuTriggerProps = (onSelect: (id: number) => void) => ({
    onMouseDown: (e: React.MouseEvent) => { if (projectMenu.menu) e.stopPropagation(); },
    onTouchStart: (e: React.TouchEvent) => { if (projectMenu.menu) e.stopPropagation(); },
    onClick: (e: React.MouseEvent) => {
      if (projectMenu.menu) projectMenu.hide();
      else projectMenu.show(e, buildProjectMenuItems(allProjects, project, onSelect));
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
                    {...projectMenuTriggerProps(handleProjectSelect)}
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
                {...projectMenuTriggerProps(handleProjectSelect)}
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

      {mobile && sidebarOpen && <div onClick={() => setSidebarOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 49 }} />}
      {mobile && (
        <div style={{
          position: 'fixed', top: 0, left: 0, bottom: 0, width: '85vw', maxWidth: 360,
          transform: sidebarOpen ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.25s ease',
          display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg)', zIndex: 50,
        }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {(['windows', 'tasks', 'files', 'repos', 'storage', 'settings'] as const).map((mid) => (
              <button key={mid} onClick={() => switchSidebarMode(mid)}
                className="icon-btn"
                style={{ flex: 1, padding: '10px 0', fontSize: 'var(--font-sm)', fontWeight: 500, cursor: 'pointer', background: sidebarMode === mid ? 'var(--accent-a15)' : 'transparent', border: 'none', borderBottom: sidebarMode === mid ? '2px solid var(--accent)' : '2px solid transparent', color: sidebarMode === mid ? 'var(--accent)' : 'var(--text-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={mid} size={20} />
              </button>
            ))}
          </div>
          <div style={{ padding: '0 8px 0 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', minHeight: 48, flexShrink: 0, position: 'relative' }}>
            <button
              {...projectMenuTriggerProps(handleMobileProjectSelect)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
                background: 'none', border: 'none', cursor: 'pointer', padding: 0, margin: 0,
                color: 'var(--text)', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project?.name || ''}</span>
              <span style={{ color: 'var(--text-dim)', flexShrink: 0, display: 'inline-flex' }}><Icon name="chevron-down" size={14} rotate={projectMenu.menu ? 180 : 0} /></span>
            </button>
            <button onClick={() => setSidebarOpen(false)} className="icon-btn" style={{ border: '1px solid var(--border)', color: 'var(--text-dim)', padding: '6px 10px', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center' }}><Icon name="close" size={16} /></button>
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {sidebarContent}
          </div>
        </div>
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

      {mobile && (
        <MobileMenuBar
          project={currentProjectItem}
          allProjects={allProjects}
          onSelectProject={handleMobileProjectSelect}
          onOpenAllProjects={() => navigate('/projects')}
          sidebarMode={sidebarMode}
          onSwitchMode={handleMobileMenuOpenMode}
          onSendKey={onSendKey}
          hidden={sidebarOpen}
          connectPane={connectPane}
          openTask={openTask}
          taskWindows={taskWindows}
        />
      )}

      {modals}

      {projectMenu.menu && <ContextMenu menu={projectMenu.menu} onClose={projectMenu.hide} />}

      {contextMenu}

      {confirmDialog}
    </div>
  );
}
