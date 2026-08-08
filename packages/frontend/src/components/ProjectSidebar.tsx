import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import AzitoLogoShort from './AzitoLogoShort';
import { usePwaInstall } from '../hooks/usePwaInstall';
import UsageDropdown from './UsageDropdown';
import NotificationBell from './notifications/NotificationBell';
import { PROJECTS_CHANGED_EVENT } from '../lib/projectsChanged';
import { paths, matchWorkspacePath } from '../paths';
import { Icon, type IconName } from './ui/Icon';
import { useProjectRail } from '../hooks/useProjectRail';
import ContextMenu, { useContextMenu } from './ContextMenu';
import { ProjectSearchPopover } from './ProjectSearchPopover';
import { useSystemUpdate } from '../hooks/useSystemUpdate';

interface ProjectItem {
  id: number;
  name: string;
  icon?: string | null;
  color?: string | null;
}

const GLOBAL_ITEMS: Array<{ labelKey: string; icon: IconName; path: string }> = [
  { labelKey: 'sidebar.servers', icon: 'servers', path: paths.servers() },
  { labelKey: 'sidebar.sidekicks', icon: 'sidekicks', path: paths.sidekicks() },
  { labelKey: 'sidebar.units', icon: 'units', path: paths.units() },
  { labelKey: 'sidebar.transcript', icon: 'transcript', path: paths.transcript() },
];

export default function ProjectSidebar() {
  const { t } = useTranslation(['projects', 'common']);
  const navigate = useNavigate();
  const location = useLocation();
  const rail = useProjectRail();
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragProjectId, setDragProjectId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: number; position: 'before' | 'after' } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const contextMenu = useContextMenu();
  const { canInstall, install } = usePwaInstall();
  const { status: updateStatus } = useSystemUpdate();
  // pathname 変化と PROJECTS_CHANGED_EVENT の両方で /projects を叩くため、応答の到着順が
  // 発行順と逆転し得る（古いリクエストが後から解決するなど）。単調増加のシーケンス番号を
  // 発行し、最新リクエストの応答だけを反映する（古い応答は setProjects/normalize せず破棄）。
  const projectsRequestSeqRef = useRef(0);

  useEffect(() => {
    const fetchProjects = () => {
      const seq = ++projectsRequestSeqRef.current;
      api<ProjectItem[]>('/projects').then((data) => {
        if (seq !== projectsRequestSeqRef.current) return; // 古い応答は破棄
        setProjects(data);
        // 取得が成功し、実際のプロジェクト一覧が確定した時にだけ正規化する。初期レンダー時の
        // 空配列（fetch未完了）や失敗時に normalize してしまうと、ピン/最近使用が誤って全消去される。
        rail.normalize(data.map((project) => project.id));
      }).catch(() => {});
    };
    fetchProjects();
    window.addEventListener(PROJECTS_CHANGED_EVENT, fetchProjects);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, fetchProjects);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  const wsMatch = matchWorkspacePath(location.pathname);
  const storedProjectId = localStorage.getItem('workspace-active-project');
  const currentProjectId = wsMatch
    ? parseInt(wsMatch.id, 10)
    : storedProjectId ? parseInt(storedProjectId, 10) : null;
  const visibleProjects = rail.getVisibleProjects(projects);
  // 並べ替えの基準は常に完全な pinned 配列（rail.pinnedIds）を使う。visibleProjects はレール表示用に
  // 上位6件へ切り詰められているため、これを基準にすると7件目以降のピンで並べ替えが壊れる。
  const { pinnedIds } = rail;

  const handlePinnedDragStart = (e: React.DragEvent, projectId: number) => {
    setDragProjectId(projectId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(projectId));
  };

  const handlePinnedDragOver = (e: React.DragEvent, projectId: number) => {
    if (dragProjectId === null || dragProjectId === projectId) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const position: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDropTarget((prev) => (prev?.id === projectId && prev.position === position ? prev : { id: projectId, position }));
  };

  const handlePinnedDrop = (e: React.DragEvent, projectId: number) => {
    if (dragProjectId === null || dragProjectId === projectId) return;
    e.preventDefault();
    const position = dropTarget?.id === projectId ? dropTarget.position : 'before';
    rail.movePinnedTo(dragProjectId, projectId, position);
    setDragProjectId(null);
    setDropTarget(null);
  };

  const handlePinnedDragEnd = () => {
    setDragProjectId(null);
    setDropTarget(null);
  };

  useEffect(() => {
    if (currentProjectId === null || Number.isNaN(currentProjectId)) return;
    rail.touch(currentProjectId);
  }, [currentProjectId, rail.touch]);

  const isActiveGlobalPath = (path: string) => location.pathname === path || location.pathname.startsWith(`${path}/`);

  const globalButtonStyle = (active: boolean): React.CSSProperties => ({
    width: 36,
    height: 36,
    borderRadius: 'var(--radius-md)',
    border: 'none',
    cursor: 'pointer',
    background: active ? 'var(--accent-a15)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-dim)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background 0.15s ease, color 0.15s ease',
  });

  return (
    <div
      ref={menuRef}
      style={{
        width: 48,
        minWidth: 48,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingTop: 6,
        gap: 6,
        background: 'var(--ws-surface)',
        overflowX: 'visible',
        scrollbarWidth: 'none',
        position: 'relative',
      }}
    >
      <button
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={t('sidebar.azitoMenu')}
        style={{
          width: 36,
          height: 36,
          minHeight: 36,
          borderRadius: 'var(--radius-md)',
          border: 'none',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          flexShrink: 0,
          position: 'relative',
          background: menuOpen ? 'var(--accent-a15)' : 'transparent',
          transition: 'background 0.15s ease',
        }}
      >
        <AzitoLogoShort size={36} />
        {updateStatus?.status === 'update-available' && (
          <span
            aria-label={t('sidebar.systemUpdate')}
            style={{
              position: 'absolute', top: 2, right: 2,
              width: 9, height: 9, borderRadius: '50%',
              background: 'var(--accent)',
              boxShadow: '0 0 0 2px var(--bg-card)',
            }}
          />
        )}
      </button>

      {menuOpen && (
        <div
          role="menu"
          aria-label={t('sidebar.azitoMenu')}
          style={{
            position: 'fixed',
            left: 56,
            top: 8,
            minWidth: 200,
            zIndex: 300,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
            padding: 6,
          }}
        >
          <button
            role="menuitem"
            className="glass-popover-item"
            onClick={() => navigate(paths.settings())}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              color: location.pathname.startsWith('/settings') ? 'var(--accent)' : 'var(--text)',
              fontSize: 'var(--font-md)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
            }}
          >
            {t('common:navigation.settings')}
          </button>
          <div style={{ height: 1, background: 'var(--border)', margin: '6px 4px' }} />
          <UsageDropdown align="left" />
          {canInstall && (
            <>
              <div style={{ height: 1, background: 'var(--border)', margin: '6px 4px' }} />
              <button
                role="menuitem"
                onClick={install}
                className="glass-popover-item"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  border: 'none',
                  color: 'var(--accent)',
                  fontSize: 'var(--font-md)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                }}
              >
                {t('sidebar.installApp')}
              </button>
            </>
          )}
        </div>
      )}

      <NotificationBell />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        {GLOBAL_ITEMS.map((item) => {
          const active = isActiveGlobalPath(item.path);
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              title={t(item.labelKey)}
              style={globalButtonStyle(active)}
              onMouseEnter={(e) => {
                if (active) return;
                e.currentTarget.style.background = 'var(--accent-a08)';
                e.currentTarget.style.color = 'var(--text)';
              }}
              onMouseLeave={(e) => {
                if (active) return;
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--text-dim)';
              }}
            >
              <Icon name={item.icon} size={20} />
            </button>
          );
        })}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          minHeight: 0,
          background: 'var(--bg)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--tray-inset)',
          padding: '6px 3px',
          margin: '2px 0',
          width: 42,
          boxSizing: 'border-box',
          alignSelf: 'center',
        }}
      >
        {visibleProjects.map((project) => {
          const isCurrent = project.id === currentProjectId;
          const isImageIcon = Boolean(project.icon?.startsWith('data:'));
          const accentColor = project.color || 'var(--accent)';
          const bgColor = isImageIcon
            ? 'transparent'
            : isCurrent
              ? accentColor
              : (project.color ? `color-mix(in srgb, ${project.color} 20%, var(--bg-card))` : 'var(--bg-card)');
          const textColor = isCurrent ? '#fff' : (project.color || 'var(--text-dim)'); // lint-allow: hex - white text on solid accent fill; no on-color token yet
          const pinnedIndex = project.isPinned ? pinnedIds.indexOf(project.id) : -1;
          const isDragging = dragProjectId === project.id;
          const dropPosition = dropTarget?.id === project.id ? dropTarget.position : null;

          return (
            <button
              key={project.id}
              onClick={() => {
                navigate(paths.workspace(project.id));
                rail.touch(project.id);
              }}
              onContextMenu={(e) => contextMenu.show(e, [
                project.isPinned
                  ? { label: t('contextMenu.unpin'), icon: <Icon name="pin" size={16} />, onClick: () => rail.unpin(project.id) }
                  : { label: t('contextMenu.pin'), icon: <Icon name="pin" size={16} />, onClick: () => rail.pin(project.id) },
                ...(project.isPinned ? [
                  {
                    label: t('contextMenu.moveUp'),
                    icon: <Icon name="chevron-down" size={16} rotate={180} />,
                    disabled: pinnedIndex <= 0,
                    onClick: () => rail.movePinned(project.id, 'up'),
                  },
                  {
                    label: t('contextMenu.moveDown'),
                    icon: <Icon name="chevron-down" size={16} />,
                    disabled: pinnedIndex === pinnedIds.length - 1,
                    onClick: () => rail.movePinned(project.id, 'down'),
                  },
                ] : []),
              ])}
              title={project.name}
              draggable={project.isPinned}
              onDragStart={project.isPinned ? (e) => handlePinnedDragStart(e, project.id) : undefined}
              onDragOver={project.isPinned ? (e) => handlePinnedDragOver(e, project.id) : undefined}
              onDrop={project.isPinned ? (e) => handlePinnedDrop(e, project.id) : undefined}
              onDragEnd={project.isPinned ? handlePinnedDragEnd : undefined}
              style={{
                width: 36,
                height: 36,
                borderRadius: 'var(--radius-md)',
                borderTop: dropPosition === 'before' ? '2px solid var(--accent)' : '2px solid transparent',
                borderBottom: dropPosition === 'after' ? '2px solid var(--accent)' : '2px solid transparent',
                borderLeft: 'none',
                borderRight: 'none',
                boxSizing: 'border-box',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: bgColor,
                color: textColor,
                fontSize: project.icon && !isImageIcon ? 18 : 15,
                fontWeight: 600,
                cursor: project.isPinned ? 'grab' : 'pointer',
                flexShrink: 0,
                transition: 'background 0.15s ease, color 0.15s ease, opacity 0.15s ease',
                boxShadow: isCurrent ? `0 0 0 2px var(--bg), 0 0 0 4px ${accentColor}` : 'none',
                opacity: isDragging ? 0.5 : 1,
                overflow: 'hidden',
              }}
              onMouseEnter={(e) => {
                if (!isCurrent && !isImageIcon) {
                  e.currentTarget.style.background = project.color
                    ? `color-mix(in srgb, ${project.color} 35%, var(--bg-card))`
                    : 'var(--accent-a15)';
                  e.currentTarget.style.color = project.color || 'var(--text)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isCurrent && !isImageIcon) {
                  e.currentTarget.style.background = bgColor;
                  e.currentTarget.style.color = textColor;
                }
              }}
            >
              {isImageIcon ? (
                <img src={project.icon!} alt="" style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-md)', objectFit: 'cover' }} />
              ) : (project.icon || project.name.charAt(0).toUpperCase())}
            </button>
          );
        })}
        <button
          ref={moreButtonRef}
          onClick={() => setSearchOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          aria-label={t('sidebar.projectMenu')}
          title={t('sidebar.projectMenu')}
          style={{
            width: 36,
            height: 36,
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            color: 'var(--text-dim)',
            border: '1px dashed var(--border)',
            fontSize: 'var(--font-xl)',
            cursor: 'pointer',
            flexShrink: 0,
            marginBottom: 8,
            transition: 'border-color 0.15s ease, color 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-dim)'; }}
        >
          <Icon name="more" size={16} />
        </button>
      </div>

      <ProjectSearchPopover
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        allProjects={projects}
        currentProjectId={currentProjectId}
        rail={rail}
        onSelectProject={(id) => navigate(paths.workspace(id))}
        anchorRef={moreButtonRef}
      />
      {contextMenu.menu && <ContextMenu menu={contextMenu.menu} onClose={contextMenu.hide} />}
    </div>
  );
}
