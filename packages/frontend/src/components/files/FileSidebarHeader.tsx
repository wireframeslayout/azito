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
        title={searchActive ? tw('sidebar.fileTree') : tw('sidebar.searchFiles')}
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
        title={tw('sidebar.gitDiff')}
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
        title={t('explorer.refresh')}
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
