import { useTranslation } from 'react-i18next';
import { useToast } from '../../hooks/useToast';
import { Icon } from '../ui/Icon';

interface PathBreadcrumbProps {
  path: string;
  onNavigate?: (path: string) => void;
  rootLabel?: string;
  navigationLabel?: string;
}

export function PathBreadcrumb({ path, onNavigate, rootLabel, navigationLabel }: PathBreadcrumbProps) {
  const { t } = useTranslation('files');
  const { showToast } = useToast();

  const handleCopy = () => {
    navigator.clipboard.writeText(path).then(() => {
      showToast(t('rootSwitcher.pathCopied'));
    });
  };

  if (onNavigate) {
    const segments = path.split('/').filter(Boolean);
    return <nav aria-label={navigationLabel} style={{ display: 'flex', flexWrap: 'wrap', minWidth: 0 }}>
      <button type="button" onClick={() => onNavigate('')}>{rootLabel}</button>
      {segments.map((segment, index) => <span key={index}> / <button type="button" onClick={() => onNavigate(`${segments.slice(0, index + 1).join('/')}/`)}>{segment}</button></span>)}
    </nav>;
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 12px',
        fontSize: 'var(--font-xs)',
        color: 'var(--text-dim)',
        flexShrink: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          direction: 'rtl',
          textAlign: 'left',
        }}
      >
        <bdi>{path}</bdi>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title={t('rootSwitcher.copyPath')}
        className="icon-btn"
        style={{
          border: 'none',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          padding: '2px 4px',
          flexShrink: 0,
          opacity: 0.6,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.6'; }}
      >
        <Icon name="clipboard" size={14} />
      </button>
    </div>
  );
}
