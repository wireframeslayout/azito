import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { BottomSheet } from '../ui/BottomSheet';
import { MobileNavMenu } from './MobileNavMenu';
import { MobileActiveWindowsPanel } from './MobileActiveWindowsPanel';
import { ResourceDropdownContent } from '../statusbar/ResourceDropdown';
import { getHealthLevel, getWorstHealth, useServerResourcesContext } from '../../hooks/useServerResources';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { paths } from '../../paths';
import type { SidebarMode } from '../../pages/workspace/types';

interface ProjectItem {
  id: number;
  name: string;
  icon?: string | null;
  color?: string | null;
}

type StackEntry = 'menu' | 'mode' | 'projectSwitch';

const MODE_TITLE_KEY: Record<SidebarMode, string> = {
  windows: 'workspace:menu.windows',
  tasks: 'workspace:menu.tasks',
  files: 'workspace:menu.files',
  repos: 'workspace:menu.repositories',
  storage: 'workspace:menu.storage',
  settings: 'workspace:sidebar.projectSettings',
};

interface MobileNavSheetProps {
  open: boolean;
  onClose: () => void;
  project: { id: number; name: string } | null;
  allProjects: ProjectItem[];
  /** プロジェクト選択（ナビゲーションのみ・シートは閉じない — 選択後は menu へ pop） */
  onSelectProject: (id: number) => void;
  sidebarMode: SidebarMode;
  switchSidebarMode: (mode: SidebarMode) => void;
  /** 既存の WorkspaceSidebarContent 出力（デスクトップ・旧SPドロワーと共有）。sidebarMode に
   * 応じてどのモード内容を描くかは呼び出し元（Workspace.tsx）が既に解決済み。 */
  sidebarContent: ReactNode;
  objectsCount: number;
  connectPane?: (serverName: string, target: string, projectId?: number) => void;
  openTask?: (taskId: number, title: string, projectId?: number) => void;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minHeight: 48,
  padding: '0 8px 0 12px',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};

/**
 * SP の ≡ シート容器（M1 メニュー → モード内容 / プロジェクト切替のスタック遷移、Issue #69 T1）。
 * 旧ドロワー（モードアイコンタブ＋各モードサイドバー直行）を置き換える。デスクトップの
 * サイドバー・レール表示には一切関与しない（WorkspaceLayout 側で mobile 分岐時のみ描画）。
 */
export function MobileNavSheet({
  open,
  onClose,
  project,
  allProjects,
  onSelectProject,
  sidebarMode,
  switchSidebarMode,
  sidebarContent,
  objectsCount,
  connectPane,
  openTask,
  taskWindows,
}: MobileNavSheetProps) {
  const { t } = useTranslation(['workspace', 'projects', 'common']);
  const navigate = useNavigate();
  const [stack, setStack] = useState<StackEntry[]>(['menu']);
  const [activeWindowsOpen, setActiveWindowsOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);

  const servers = useServerResourcesContext();
  const worstHealth = getWorstHealth(servers.map((s) => getHealthLevel(s.measurement)));
  const { totalCount: awCount, blockedCount: awBlockedCount } = useActiveWindowRows();

  // シートを開き直すたびにメニュー階層をリセットする（前回どこまで潜っていたかを持ち越さない）。
  useEffect(() => {
    if (open) setStack(['menu']);
  }, [open]);

  const push = (entry: StackEntry) => setStack((s) => [...s, entry]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const handleSelectMode = (mode: SidebarMode) => {
    switchSidebarMode(mode);
    push('mode');
  };

  const handleSelectProject = (id: number) => {
    onSelectProject(id);
    setStack(['menu']);
  };

  // サーバーヘルス／稼働ペイン一覧は暫定行（T6 で ServerHealthSheet に置き換え）。開いたら
  // ナビゲーションシート自体は閉じる（モック準拠の「実体オープンでシートを閉じる」に倣う）。
  const handleOpenActiveWindows = connectPane && openTask
    ? () => { onClose(); setActiveWindowsOpen(true); }
    : undefined;
  const handleOpenServerHealth = () => { onClose(); setHealthOpen(true); };

  const top = stack[stack.length - 1];
  const depth = stack.length;
  const headerTitle = top === 'projectSwitch'
    ? t('workspace:mobileNav.projectSwitch')
    : top === 'mode' ? t(MODE_TITLE_KEY[sidebarMode]) : null;

  return (
    <>
      {open && (
        <>
          <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 49 }} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('workspace:mobile.navMenu')}
            style={{
              position: 'fixed', top: 0, right: 0, bottom: 0, left: 0,
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              background: 'var(--bg-solid)', zIndex: 50,
              boxShadow: 'var(--shadow-3)',
            }}
          >
            <div style={headerStyle}>
              {depth > 1 ? (
                <button
                  type="button"
                  onClick={pop}
                  aria-label={t('common:actions.back')}
                  className="icon-btn"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0,
                    border: 'none', background: 'none', color: 'var(--text)', cursor: 'pointer',
                    padding: '6px 4px', textAlign: 'left',
                  }}
                >
                  <Icon name="chevron-left" size={20} />
                  <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {headerTitle}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => push('projectSwitch')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0,
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    color: 'var(--text)', textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 'var(--font-base)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {project?.name || ''}
                  </span>
                  <span style={{ color: 'var(--text-dim)', flexShrink: 0, display: 'inline-flex' }}><Icon name="chevron-down" size={14} /></span>
                </button>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label={t('common:actions.close')}
                className="icon-btn"
                style={{
                  width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 'none', background: 'none', color: 'var(--text-dim)', cursor: 'pointer', flexShrink: 0,
                }}
              >
                <Icon name="close" size={20} />
              </button>
            </div>

            <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
              {top === 'menu' && (
                <MobileNavMenu
                  objectsCount={objectsCount}
                  onSelectMode={handleSelectMode}
                  onNavigateGlobal={(path) => { navigate(path); onClose(); }}
                  onOpenActiveWindows={handleOpenActiveWindows}
                  activeWindowsCount={awCount}
                  activeWindowsBlockedCount={awBlockedCount}
                  onOpenServerHealth={handleOpenServerHealth}
                  serverHealth={worstHealth}
                />
              )}
              {top === 'mode' && sidebarContent}
              {top === 'projectSwitch' && (
                <MobileProjectSwitchList
                  allProjects={allProjects}
                  currentProjectId={project?.id ?? null}
                  onSelect={handleSelectProject}
                  onNewProject={() => { navigate(paths.projectNew()); onClose(); }}
                />
              )}
            </div>
          </div>
        </>
      )}

      {activeWindowsOpen && connectPane && openTask && (
        <MobileActiveWindowsPanel
          onClose={() => setActiveWindowsOpen(false)}
          connectPane={connectPane}
          openTask={openTask}
          taskWindows={taskWindows ?? []}
        />
      )}

      <BottomSheet open={healthOpen} onClose={() => setHealthOpen(false)} title={t('workspace:mobile.serverHealth')}>
        {servers.map((s) => (
          <ResourceDropdownContent key={s.serverName} serverName={s.serverName} health={getHealthLevel(s.measurement)} meterWidth={90} />
        ))}
      </BottomSheet>
    </>
  );
}

function MobileProjectSwitchList({
  allProjects,
  currentProjectId,
  onSelect,
  onNewProject,
}: {
  allProjects: ProjectItem[];
  currentProjectId: number | null;
  onSelect: (id: number) => void;
  onNewProject: () => void;
}) {
  const { t } = useTranslation('projects');

  return (
    <div style={{ padding: '4px 4px 12px' }}>
      {allProjects.map((p) => {
        const isCurrent = p.id === currentProjectId;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelect(p.id)}
            aria-current={isCurrent ? 'true' : undefined}
            className="glass-popover-item"
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44,
              padding: '0 10px', border: 'none', background: isCurrent ? 'var(--bg-hover)' : 'none',
              borderRadius: 'var(--radius-md)', cursor: 'pointer', color: 'var(--text)',
              textAlign: 'left', fontFamily: 'inherit', fontSize: 'var(--font-md)',
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: p.color || 'var(--border)', flexShrink: 0 }}
            />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            {isCurrent && <Icon name="check" size={16} style={{ color: 'var(--accent)' }} />}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onNewProject}
        className="glass-popover-item"
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 44,
          padding: '0 10px', border: 'none', background: 'none', borderRadius: 'var(--radius-md)',
          cursor: 'pointer', color: 'var(--text-dim)', textAlign: 'left', fontFamily: 'inherit',
          fontSize: 'var(--font-md)', marginTop: 4,
        }}
      >
        <Icon name="plus" size={16} />
        <span>{t('search.newProject')}</span>
      </button>
    </div>
  );
}
