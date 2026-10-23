import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';

interface FileSidebarHeaderProps {
  onSearch: () => void;
  onDiff: () => void;
  onRefresh: () => void;
  searchActive: boolean;
  serverName?: string;
  serverCount: number;
  allServerNames?: string[];
  onSelectServer?: (name: string) => void;
  /** Why file operations / version control are closed on this server's host (a Windows agent); null / absent: open. A closed button is disabled and says why. */
  filesBlockedReason?: string | null;
  gitBlockedReason?: string | null;
}

export function FileSidebarHeader({
  onSearch,
  onDiff,
  onRefresh,
  searchActive,
  serverName,
  serverCount,
  allServerNames,
  onSelectServer,
  filesBlockedReason,
  gitBlockedReason,
}: FileSidebarHeaderProps) {
  const { t } = useTranslation('files');
  const { t: tw } = useTranslation('workspace');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 12px',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          flex: 1,
          fontSize: 'var(--font-xs)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'var(--text-dim)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {t('sidebar.title')}
        {serverCount > 1 && serverName && (
          <Badge
            tone="neutral"
            style={{
              fontSize: 'var(--font-xxs)',
              padding: '0 5px',
              textTransform: 'none',
              letterSpacing: 0,
              cursor: allServerNames && allServerNames.length > 1 ? 'pointer' : undefined,
            }}
          >
            {allServerNames && allServerNames.length > 1 ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!allServerNames || !onSelectServer) return;
                  const idx = allServerNames.indexOf(serverName);
                  const next = allServerNames[(idx + 1) % allServerNames.length];
                  onSelectServer(next);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'inherit',
                  font: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                {serverName} ↻
              </button>
            ) : serverName}
          </Badge>
        )}
      </span>
      <button
        type="button"
        onClick={onSearch}
        disabled={!!filesBlockedReason}
        title={filesBlockedReason ?? (searchActive ? tw('sidebar.fileTree') : tw('sidebar.searchFiles'))}
        aria-pressed={searchActive}
        className="icon-btn"
        style={{
          border: 'none',
          color: searchActive ? 'var(--accent)' : 'var(--text-dim)',
          cursor: 'pointer',
          padding: '2px 6px',
        }}
      >
        <Icon name="search" size={14} />
      </button>
      <button
        type="button"
        onClick={onDiff}
        disabled={!!gitBlockedReason}
        title={gitBlockedReason ?? tw('sidebar.gitDiff')}
        className="icon-btn"
        style={{
          border: 'none',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          padding: '2px 6px',
        }}
      >
        <Icon name="git-commit" size={14} />
      </button>
      <button
        type="button"
        onClick={onRefresh}
        disabled={!!filesBlockedReason}
        title={filesBlockedReason ?? t('explorer.refresh')}
        className="icon-btn"
        style={{
          border: 'none',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          padding: '2px 6px',
        }}
      >
        <Icon name="refresh" size={14} />
      </button>
    </div>
  );
}
