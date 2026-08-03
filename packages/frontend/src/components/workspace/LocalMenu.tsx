import { useTranslation } from 'react-i18next';
import type { SidebarMode } from '../../pages/workspace/types';
import { Icon, type IconName } from '../ui/Icon';
import ActiveWindowIcons from './ActiveWindowIcons';

const SIDEBAR_ICONS: Record<string, IconName> = {
  windows: 'windows',
  tasks: 'tasks',
  files: 'files',
  repos: 'repos',
  storage: 'storage',
  settings: 'settings',
};

const ACTIVITY_BUTTONS: { id: SidebarMode; labelKey: string }[] = [
  { id: 'windows', labelKey: 'menu.windows' },
  { id: 'tasks', labelKey: 'menu.tasks' },
  { id: 'files', labelKey: 'menu.files' },
  { id: 'repos', labelKey: 'menu.repositories' },
  { id: 'storage', labelKey: 'menu.storage' },
];

interface LocalMenuProps {
  collapsed: boolean;
  sidebarMode: SidebarMode;
  onModeClick: (mode: SidebarMode, e?: React.MouseEvent) => void;
  onExpand?: () => void;
  connectPane?: (serverName: string, target: string, projectId?: number) => void;
  openTask?: (taskId: number, title: string, projectId?: number) => void;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
  /** 収納時、展開ボタン直下に表示するプロジェクトアバターボタン。WorkspaceLayout 側で
   *  project/allProjects/projectMenu を使って組み立てて渡す（LocalMenu は中身を知らない）。 */
  projectAvatar?: React.ReactNode;
}

const btnStyle = (active: boolean): React.CSSProperties => ({
  width: 36,
  height: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: active ? 'var(--accent-a15)' : 'transparent',
  border: 'none',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
  color: active ? 'var(--accent)' : 'var(--text-dim)',
  fontSize: 'var(--font-lg)',
  transition: 'color 0.1s ease, background 0.1s ease',
});

export default function LocalMenu({
  collapsed,
  sidebarMode,
  onModeClick,
  onExpand,
  connectPane,
  openTask,
  taskWindows,
  projectAvatar,
}: LocalMenuProps) {
  const { t } = useTranslation(['workspace', 'common']);
  return (
    <nav
      className="ws-surface"
      aria-label={t('workspace:menu.localMenu')}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        width: 48,
        minWidth: 48,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 6,
        gap: 2,
        background: 'transparent',
        zIndex: 51,
      }}
    >
      {/* 収納時のみ: 最上段に展開ボタン + プロジェクトアバター */}
      {collapsed && onExpand && (
        <button
          onClick={onExpand}
          title={t('common:navigation.expandSidebar')}
          className="icon-btn"
          style={{ ...btnStyle(false), marginBottom: 2 }}
        >
          <Icon name="panel-left-open" size={16} />
        </button>
      )}
      {collapsed && projectAvatar}

      {/* プロジェクトメニュー（上段） */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          flex: collapsed ? undefined : 1,
        }}
      >
        {ACTIVITY_BUTTONS.map((m) => (
          <button
            key={m.id}
            onClick={(e) => onModeClick(m.id, e)}
            title={t(`workspace:${m.labelKey}`)}
            className="icon-btn"
            style={btnStyle(sidebarMode === m.id)}
          >
            <Icon name={m.id} size={20} />
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={(e) => onModeClick('settings', e)}
          title={t('workspace:sidebar.projectSettings')}
          className="icon-btn"
          style={btnStyle(sidebarMode === 'settings')}
        >
          <Icon name="settings" size={20} />
        </button>
      </div>

      {/* 収納時のみ: 分割線 + アクティブウィンドウエリア */}
      {collapsed && (
        <>
          <div
            style={{
              width: '100%',
              height: 1,
              background: 'var(--border)',
              flexShrink: 0,
            }}
          />
          {connectPane && openTask && (
            <ActiveWindowIcons
              connectPane={connectPane}
              openTask={openTask}
              taskWindows={taskWindows ?? []}
            />
          )}
        </>
      )}
    </nav>
  );
}

export { SIDEBAR_ICONS };
