import { useTranslation } from 'react-i18next';
import { useToast } from '../../hooks/useToast';
import { Icon } from '../ui/Icon';

interface PathBreadcrumbProps {
  path: string;
  onNavigate?: (path: string) => void;
  rootLabel?: string;
  navigationLabel?: string;
  mobile?: boolean;
  separator?: string;
}

export function PathBreadcrumb({ path, onNavigate, rootLabel, navigationLabel, mobile = false, separator = '/' }: PathBreadcrumbProps) {
  const { t } = useTranslation('files');
  const { showToast } = useToast();

  const handleCopy = () => {
    navigator.clipboard.writeText(path).then(() => {
      showToast(t('rootSwitcher.pathCopied'));
    });
  };

  if (onNavigate) {
    const segments = path.split('/').filter(Boolean);
    const crumbStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 'var(--space-1) var(--space-1)', minWidth: mobile ? 'calc(var(--space-6) + var(--space-5))' : undefined, minHeight: mobile ? 'calc(var(--space-6) + var(--space-5))' : undefined, color: 'var(--text-dim)', fontSize: 'var(--font-xs)', cursor: 'pointer', overflowWrap: 'anywhere', textAlign: 'left' };
    return <nav aria-label={navigationLabel} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', padding: 'var(--space-1) var(--space-3)', minWidth: 0, flexShrink: 0, fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
      <button type="button" className="icon-btn" style={crumbStyle} aria-current={segments.length === 0 ? 'location' : undefined} onClick={() => onNavigate('')}>{rootLabel}</button>
      {segments.map((segment, index) => <span key={index} style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>/<button type="button" className="icon-btn" style={crumbStyle} aria-current={index === segments.length - 1 ? 'location' : undefined} onClick={() => onNavigate(`${segments.slice(0, index + 1).join('/')}/`)}>{segment}</button></span>)}
    </nav>;
  }

  const parts = path.split(separator === '\\' ? /[\\/]+/ : /\/+/).filter(Boolean);
  if (separator === '\\' && path.startsWith('\\\\')) parts.unshift('\\\\');
  else if (path.startsWith(separator)) parts.unshift(separator);

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
        <span className="sr-only">{path}</span>
        <bdi aria-hidden="true">{parts.map((part, index) => <span key={index}>{index > 0 && <span style={{ margin: '0 var(--space-1)' }}>›</span>}{part}</span>)}</bdi>
      </div>
      <button
        type="button"
        onClick={handleCopy}
        title={t('rootSwitcher.copyPath')}
        aria-label={t('rootSwitcher.copyPath')}
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
