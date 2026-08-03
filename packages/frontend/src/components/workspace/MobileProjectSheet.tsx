import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { paths } from '../../paths';
import { useProjectRail } from '../../hooks/useProjectRail';
import { BottomSheet } from '../ui/BottomSheet';
import { ProjectSearchContent } from '../ProjectSearchContent';

interface MobileProjectSheetProps {
  open: boolean;
  onClose: () => void;
  allProjects: Array<{ id: number; name: string; icon?: string | null; color?: string | null }>;
  currentProjectId: number | null;
  onSelectProject: (id: number) => void;
  onOpenAllProjects: () => void;
}

export function MobileProjectSheet({ open, onClose, allProjects, currentProjectId, onSelectProject, onOpenAllProjects }: MobileProjectSheetProps) {
  const { t } = useTranslation('workspace');
  const navigate = useNavigate();
  const rail = useProjectRail();
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (open) setSearchQuery('');
  }, [open]);

  return (
    <BottomSheet open={open} onClose={onClose} title={t('mobile.projects')}>
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
          onOpenAllProjects();
          onClose();
        }}
        onOpenNewProject={() => {
          navigate(paths.projectNew());
          onClose();
        }}
      />
    </BottomSheet>
  );
}
