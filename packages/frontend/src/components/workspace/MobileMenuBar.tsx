import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SidebarMode } from '../../pages/workspace/types';
import { MobileKeyboardOverlay } from '../ui/MobileKeyboardOverlay';
import { useVirtualKeyboard } from '../../hooks/useVirtualKeyboard';
import { useNotificationCenter } from '../../hooks/useNotificationCenter';
import { NotificationCenterPanel } from '../notifications/NotificationCenterPanel';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { BrailleSpinner } from '../ui/WindowActivityIndicator';
import { MobileActiveWindowsPanel } from './MobileActiveWindowsPanel';
import { ProjectAvatar } from '../ui/ProjectAvatar';
import { Icon, type IconName } from '../ui/Icon';
import { MobileProjectSheet } from './MobileProjectSheet';
import { MobileModeSheet } from './MobileModeSheet';
import { MobileGlobalMenuSheet } from './MobileGlobalMenuSheet';
import { getHealthLevel, getWorstHealth, useServerResourcesContext } from '../../hooks/useServerResources';
import { HealthDot } from '../statusbar/HealthDot';
import { ResourceDropdownContent } from '../statusbar/ResourceDropdown';
import { BottomSheet } from '../ui/BottomSheet';

export interface MobileMenuProjectItem {
  id: number;
  name: string;
  icon?: string;
  color?: string;
}

export interface MobileMenuBarProps {
  project: { id: number; name: string; icon?: string; color?: string } | null;
  allProjects: MobileMenuProjectItem[];
  onSelectProject: (id: number) => void;
  onOpenAllProjects: () => void;
  sidebarMode: SidebarMode;
  onSwitchMode: (mode: SidebarMode) => void;
  onSendKey?: (key: string) => void;
  hidden?: boolean;
  connectPane?: (serverName: string, target: string, projectId?: number) => void;
  openTask?: (taskId: number, title: string, projectId?: number) => void;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

type OpenPopover = 'project' | 'mode' | 'globalMenu' | 'notifications' | 'activeWindows' | 'health' | null;

const ICON_SIZE = 19;

const MODE_ICONS: Record<string, IconName> = {
  windows: 'windows',
  tasks: 'tasks',
  files: 'files',
  repos: 'repos',
  storage: 'storage',
  settings: 'settings',
};

function MiscIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width={ICON_SIZE} height={ICON_SIZE}>
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={ICON_SIZE} height={ICON_SIZE}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

function ActiveWindowsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={ICON_SIZE} height={ICON_SIZE}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" width={19} height={19}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  );
}

export function MobileMenuBar({
  project,
  allProjects,
  onSelectProject,
  onOpenAllProjects,
  sidebarMode,
  onSwitchMode,
  onSendKey,
  hidden,
  connectPane,
  openTask,
  taskWindows,
}: MobileMenuBarProps) {
  const { t } = useTranslation('workspace');
  const keyboardVisible = useVirtualKeyboard();
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const [keyboardOverlayOpen, setKeyboardOverlayOpen] = useState(false);
  const { unreadCount } = useNotificationCenter();
  const { rows: awRows, totalCount: awCount, blockedCount: awBlockedCount } = useActiveWindowRows();
  const hasWorking = awRows.some((r) => r.status === 'running' && r.activityStatus !== 'blocked');
  const servers = useServerResourcesContext();
  const worstHealth = getWorstHealth(servers.map((s) => getHealthLevel(s.measurement)));

  const togglePopover = (name: OpenPopover) => setOpenPopover((prev) => (prev === name ? null : name));
  const closePopover = () => setOpenPopover(null);

  useEffect(() => {
    if (keyboardVisible || hidden) setOpenPopover(null);
  }, [keyboardVisible, hidden]);

  useEffect(() => {
    if (keyboardVisible || hidden) setKeyboardOverlayOpen(false);
  }, [keyboardVisible, hidden]);

  return (
    <>
      <nav
        aria-label={t('mobile.mobileMenu')}
        className={`mobile-menu-bar${keyboardVisible || hidden ? ' mobile-menu-bar-hidden' : ''}`}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 'calc(16px + env(safe-area-inset-bottom))',
          display: 'flex',
          justifyContent: 'center',
          zIndex: 120,
        }}
      >
        <div className="mobile-menu-group" role="group" aria-label={t('mobile.projectAndMode')}>
          <button
            className={`mi-btn${openPopover === 'project' ? ' mi-btn-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={openPopover === 'project'}
            title={t('mobile.projectSwitch')}
            onClick={() => togglePopover('project')}
          >
            <ProjectAvatar project={project} size={24} />
          </button>
          <button
            className={`mi-btn${openPopover === 'mode' ? ' mi-btn-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={openPopover === 'mode'}
            title={t('mobile.displayMode')}
            onClick={() => togglePopover('mode')}
          >
            <Icon name={MODE_ICONS[sidebarMode]} size={20} />
          </button>
        </div>

        <div className="mobile-menu-group" role="group" aria-label={t('mobile.appMenu')} style={{ position: 'relative' }}>
          <button
            className={`mi-btn${keyboardOverlayOpen ? ' mi-btn-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={keyboardOverlayOpen}
            title={t('mobile.keyboardControls')}
            onClick={() => setKeyboardOverlayOpen((prev) => !prev)}
          >
            <KeyboardIcon />
          </button>

          <button
            className={`mi-btn${openPopover === 'activeWindows' ? ' mi-btn-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={openPopover === 'activeWindows'}
            aria-label={awCount > 0 ? t('activeWindows.titleWithCount', { count: awCount }) : t('activeWindows.title')}
            title={t('activeWindows.title')}
            onClick={() => togglePopover('activeWindows')}
          >
            {hasWorking ? (
              <span style={{ fontSize: 'var(--font-lg)' }}><BrailleSpinner /></span>
            ) : (
              <ActiveWindowsIcon />
            )}
            {awCount > 0 && (
              <span aria-hidden="true" className={`mi-btn-badge${awBlockedCount > 0 ? ' mi-btn-badge-alert' : ''}`}>
                {awCount > 99 ? '99+' : awCount}
              </span>
            )}
          </button>

          <button
            className={`mi-btn${openPopover === 'notifications' ? ' mi-btn-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={openPopover === 'notifications'}
            aria-label={unreadCount > 0 ? t('mobile.notificationsUnread', { count: unreadCount }) : t('mobile.notifications')}
            title={t('mobile.notifications')}
            onClick={() => togglePopover('notifications')}
          >
            <BellIcon />
            {unreadCount > 0 && (
              <span aria-hidden="true" className="mi-btn-badge mi-btn-badge-alert">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          <button
            className={`mi-btn${openPopover === 'globalMenu' ? ' mi-btn-active' : ''}`}
            aria-haspopup="dialog"
            aria-expanded={openPopover === 'globalMenu'}
            title={t('mobile.menu')}
            onClick={() => togglePopover('globalMenu')}
          >
            <MiscIcon />
          </button>

          <button
            aria-label={t('mobile.serverHealth')}
            title={t('mobile.serverHealth')}
            onClick={() => togglePopover('health')}
            style={{
              position: 'absolute',
              top: -3,
              right: -3,
              width: 14,
              height: 14,
              padding: 0,
              border: '1.5px solid var(--bg)',
              borderRadius: '50%',
              background: 'transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 1,
            }}
          >
            <HealthDot level={worstHealth} size={10} />
          </button>
        </div>
      </nav>

      <MobileProjectSheet
        open={openPopover === 'project'}
        onClose={closePopover}
        allProjects={allProjects}
        currentProjectId={project?.id ?? null}
        onSelectProject={onSelectProject}
        onOpenAllProjects={onOpenAllProjects}
      />
      <MobileModeSheet open={openPopover === 'mode'} onClose={closePopover} currentMode={sidebarMode} onSwitchMode={onSwitchMode} />
      <MobileGlobalMenuSheet open={openPopover === 'globalMenu'} onClose={closePopover} />
      {openPopover === 'notifications' && <NotificationCenterPanel anchor="fullscreen" onClose={closePopover} />}
      {openPopover === 'activeWindows' && connectPane && openTask && (
        <MobileActiveWindowsPanel
          onClose={closePopover}
          connectPane={connectPane}
          openTask={openTask}
          taskWindows={taskWindows ?? []}
        />
      )}
      {keyboardOverlayOpen && (
        <MobileKeyboardOverlay onSendKey={(key) => onSendKey?.(key)} onClose={() => setKeyboardOverlayOpen(false)} />
      )}
      <BottomSheet open={openPopover === 'health'} onClose={closePopover} title={t('mobile.serverHealth')}>
        {servers.map((s) => (
          <ResourceDropdownContent
            key={s.serverName}
            serverName={s.serverName}
            health={getHealthLevel(s.measurement)}
            meterWidth={90}
          />
        ))}
      </BottomSheet>
    </>
  );
}
