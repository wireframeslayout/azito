import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './ui/Icon';
import { ProjectAvatar } from './ui/ProjectAvatar';
import type { RailProject } from '../hooks/useProjectRail';

function moveButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: 20,
    height: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: 0,
    flexShrink: 0,
    color: 'var(--text-dim)',
    opacity: disabled ? 0.25 : 0.7,
    cursor: disabled ? 'default' : 'pointer',
  };
}

interface ProjectSearchContentProps {
  projects: RailProject[];
  currentProjectId: number | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onSelect: (id: number) => void;
  onPin: (id: number) => void;
  onUnpin: (id: number) => void;
  onMoveUp?: (id: number) => void;
  onMoveDown?: (id: number) => void;
  onMovePinnedTo?: (sourceId: number, targetId: number, position: 'before' | 'after') => void;
  onOpenAllProjects: () => void;
  onOpenNewProject: () => void;
}

export function ProjectSearchContent({
  projects,
  currentProjectId,
  searchQuery,
  onSearchChange,
  onSelect,
  onPin,
  onUnpin,
  onMoveUp,
  onMoveDown,
  onMovePinnedTo,
  onOpenAllProjects,
  onOpenNewProject,
}: ProjectSearchContentProps) {
  const { t } = useTranslation('projects');
  const query = searchQuery.trim().toLowerCase();
  const isFiltering = query.length > 0;
  const filteredProjects = isFiltering
    ? projects.filter((project) => project.name.toLowerCase().includes(query))
    : projects;
  // `projects` はピン留め（手動順）→最近使用の順で渡ってくる想定なので、この並びの先頭側連続区間がピン留め区間になる。
  const pinnedIds = projects.filter((project) => project.isPinned).map((project) => project.id);
  const [dragProjectId, setDragProjectId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: number; position: 'before' | 'after' } | null>(null);
  // 検索フィルタ適用中は部分リスト上での並べ替えが混乱を招くため DnD を無効化する。
  const dndEnabled = Boolean(onMovePinnedTo) && !isFiltering;

  const handlePinnedDragStart = (e: React.DragEvent, projectId: number) => {
    if ((e.target as HTMLElement).closest('button')) {
      // 移動/ピンボタン起点のドラッグは行の並べ替えとして扱わない
      e.preventDefault();
      return;
    }
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
    onMovePinnedTo?.(dragProjectId, projectId, position);
    setDragProjectId(null);
    setDropTarget(null);
  };

  const handlePinnedDragEnd = () => {
    setDragProjectId(null);
    setDropTarget(null);
  };

  const actionStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '9px 10px',
    borderRadius: 'var(--radius-md)',
    border: 'none',
    color: 'var(--text)',
    fontSize: 'var(--font-md)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  };

  return (
    <div>
      <input
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t('search.placeholder')}
        autoFocus
        style={{
          width: 'calc(100% - 12px)',
          padding: '8px 10px',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text)',
          fontSize: 'var(--font-md)',
          outline: 'none',
          margin: 6,
          boxSizing: 'border-box',
        }}
      />
      <div>
        {filteredProjects.map((project) => {
          const isPinnedDraggable = dndEnabled && project.isPinned;
          const isDragging = dragProjectId === project.id;
          const dropPosition = dropTarget?.id === project.id ? dropTarget.position : null;
          return (
          <div
            key={project.id}
            role="button"
            tabIndex={0}
            className={`glass-popover-item${project.id === currentProjectId ? ' selected' : ''}`}
            onClick={() => onSelect(project.id)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return; // 子ボタン（移動/ピン）からのバブリングは無視する
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onSelect(project.id);
            }}
            draggable={isPinnedDraggable}
            onDragStart={isPinnedDraggable ? (e) => handlePinnedDragStart(e, project.id) : undefined}
            onDragOver={isPinnedDraggable ? (e) => handlePinnedDragOver(e, project.id) : undefined}
            onDrop={isPinnedDraggable ? (e) => handlePinnedDrop(e, project.id) : undefined}
            onDragEnd={isPinnedDraggable ? handlePinnedDragEnd : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '8px 10px',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              borderTop: dropPosition === 'before' ? '2px solid var(--accent)' : '2px solid transparent',
              borderBottom: dropPosition === 'after' ? '2px solid var(--accent)' : '2px solid transparent',
              color: 'var(--text)',
              fontSize: 'var(--font-md)',
              cursor: isPinnedDraggable ? 'grab' : 'pointer',
              textAlign: 'left',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
              opacity: isDragging ? 0.5 : 1,
            }}
          >
            <ProjectAvatar project={project} size={24} />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
            {project.isPinned && (onMoveUp || onMoveDown) && (() => {
              const pinnedIndex = pinnedIds.indexOf(project.id);
              const isFirstPinned = pinnedIndex <= 0;
              const isLastPinned = pinnedIndex === pinnedIds.length - 1;
              return (
                <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                  <button
                    type="button"
                    aria-label={t('contextMenu.moveUp')}
                    disabled={isFirstPinned}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveUp?.(project.id);
                    }}
                    className="icon-btn"
                    style={moveButtonStyle(isFirstPinned)}
                  >
                    <span style={{ display: 'inline-flex' }}>
                      <Icon name="chevron-down" size={14} rotate={180} />
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('contextMenu.moveDown')}
                    disabled={isLastPinned}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMoveDown?.(project.id);
                    }}
                    className="icon-btn"
                    style={moveButtonStyle(isLastPinned)}
                  >
                    <span style={{ display: 'inline-flex' }}>
                      <Icon name="chevron-down" size={14} />
                    </span>
                  </button>
                </span>
              );
            })()}
            <button
              type="button"
              aria-label={project.isPinned ? t('contextMenu.unpin') : t('contextMenu.pin')}
              onClick={(e) => {
                e.stopPropagation();
                if (project.isPinned) onUnpin(project.id);
                else onPin(project.id);
              }}
              className="icon-btn"
              style={{
                width: 24,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                flexShrink: 0,
                color: project.isPinned ? 'var(--accent)' : 'var(--text-dim)',
                opacity: project.isPinned ? 1 : 0.3,
              }}
            >
              <Icon name="pin" size={14} />
            </button>
          </div>
          );
        })}
      </div>
      <div style={{ height: 1, background: 'var(--border)', margin: '6px 4px' }} />
      <button className="glass-popover-item" onClick={onOpenAllProjects} style={actionStyle}>
        <Icon name="projects" size={16} />
        <span>{t('search.allProjects')}</span>
      </button>
      <button className="glass-popover-item" onClick={onOpenNewProject} style={actionStyle}>
        <Icon name="plus" size={16} />
        <span>{t('search.newProject')}</span>
      </button>
    </div>
  );
}
