import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { paths } from '../paths';
import { ProjectSearchContent } from './ProjectSearchContent';
import type { UseProjectRailReturn } from '../hooks/useProjectRail';

interface ProjectSearchPopoverProps {
  open: boolean;
  onClose: () => void;
  allProjects: Array<{ id: number; name: string; icon?: string | null; color?: string | null }>;
  currentProjectId: number | null;
  rail: UseProjectRailReturn;
  onSelectProject: (id: number) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

const POPOVER_MAX_HEIGHT = 400;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

export function ProjectSearchPopover({ open, onClose, allProjects, currentProjectId, rail, onSelectProject, anchorRef }: ProjectSearchPopoverProps) {
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: VIEWPORT_MARGIN, left: 56 });

  useEffect(() => {
    if (open) setSearchQuery('');
  }, [open]);

  const recalculatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? POPOVER_MAX_HEIGHT;
    const left = anchorRect.right + ANCHOR_GAP;
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
    const top = Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.top, maxTop));
    setPosition({ top, left });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    recalculatePosition();
  }, [open, recalculatePosition]);

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;

    const resizeObserver = new ResizeObserver(() => {
      recalculatePosition();
    });
    resizeObserver.observe(node);

    window.addEventListener('resize', recalculatePosition);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', recalculatePosition);
    };
  }, [open, recalculatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: 260,
        maxHeight: Math.min(POPOVER_MAX_HEIGHT, window.innerHeight - 2 * VIEWPORT_MARGIN),
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 12px 36px rgba(0,0,0,0.55)',
        zIndex: 300,
        padding: 6,
        overflowY: 'auto',
      }}
    >
      <ProjectSearchContent
        projects={rail.getAllSortedProjects(allProjects)}
        currentProjectId={currentProjectId}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSelect={(id) => {
          onSelectProject(id);
          rail.touch(id);
          onClose();
        }}
        onPin={rail.pin}
        onUnpin={rail.unpin}
        onMoveUp={(id) => rail.movePinned(id, 'up')}
        onMoveDown={(id) => rail.movePinned(id, 'down')}
        onMovePinnedTo={rail.movePinnedTo}
        onOpenAllProjects={() => {
          navigate(paths.projects());
          onClose();
        }}
        onOpenNewProject={() => {
          navigate(paths.projectNew());
          onClose();
        }}
      />
    </div>
  );
}
