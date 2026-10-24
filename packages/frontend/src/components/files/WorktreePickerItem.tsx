import { useTranslation } from 'react-i18next';
import type { HostPathApi } from '@azito/shared';
import { Badge } from '../ui/Badge';
import type { WorktreeItem } from './RootSwitcher';

const RUNNING_STATUSES = new Set(['running', 'in_progress', 'waiting_input', 'phase_review', 'pending_approval']);

interface WorktreePickerItemProps {
  item: WorktreeItem;
  pathApi: HostPathApi;
  isSelected: boolean;
  isHighlighted: boolean;
  onClick: () => void;
}

const POSIX_WORKTREE_DIR = /\/\.worktrees\/(.+)$/;
const WIN32_WORKTREE_DIR = /[\\/]\.worktrees[\\/](.+)$/;

/** The name a worktree is listed by: the main checkout's directory name, or the folder under `.worktrees` (`pathApi`: the host's OS). */
export function getWorktreeName(worktree: WorktreeItem, pathApi: HostPathApi): string {
  if (worktree.isMain) return pathApi.basename(worktree.path) || worktree.path;
  return worktree.path.match(pathApi.sep === '\\' ? WIN32_WORKTREE_DIR : POSIX_WORKTREE_DIR)?.[1] ?? worktree.path;
}

export function WorktreePickerItem({ item, pathApi, isSelected, isHighlighted, onClick }: WorktreePickerItemProps) {
  const { t } = useTranslation('files');
  const isRunning = item.taskStatus != null && RUNNING_STATUSES.has(item.taskStatus);
  const name = getWorktreeName(item, pathApi);

  return (
    <div
      role="option"
      aria-selected={isSelected}
      onClick={onClick}
      style={{
        padding: '6px 10px',
        cursor: 'pointer',
        background: isHighlighted ? 'var(--accent-a15)' : isSelected ? 'var(--accent-a08)' : 'transparent',
        borderRadius: 'var(--radius-sm)',
        margin: '0 4px',
      }}
      onMouseEnter={(e) => {
        if (!isHighlighted && !isSelected) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isHighlighted ? 'var(--accent-a15)' : isSelected ? 'var(--accent-a08)' : 'transparent';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 'var(--font-sm)',
            color: 'var(--text)',
            fontWeight: isSelected ? 600 : 400,
          }}
        >
          {name}
        </span>
        <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {item.isMain && <Badge tone="neutral">{t('worktrees.mainLabel')}</Badge>}
          {item.taskId != null && isRunning && <Badge tone="green">#{item.taskId} {t('worktrees.running')}</Badge>}
          {item.taskId != null && !isRunning && <Badge tone="neutral">#{item.taskId}</Badge>}
          {item.orphaned && <Badge tone="orange">{t('worktrees.orphaned')}</Badge>}
        </span>
      </div>
      {item.branch && (
        <div
          style={{
            fontSize: 'var(--font-xs)',
            color: 'var(--text-dim)',
            fontFamily: 'var(--mono)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.branch}
        </div>
      )}
    </div>
  );
}
