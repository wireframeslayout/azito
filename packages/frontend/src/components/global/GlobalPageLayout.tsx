import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { paths, matchWorkspacePath } from '../../paths';
import { Icon } from '../ui/Icon';

interface GlobalPageLayoutProps {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  backLabel?: string;
  onBack?: () => void;
  /** ページ側が自前のヘッダー（戻る＋タイトル＋アクション）を描画する時に、二重ヘッダーを避けるため
   * このレイアウトの共通ヘッダーを抑制する（例: トランスクリプトの会話ビュー表示中）。 */
  hideHeader?: boolean;
}

export default function GlobalPageLayout({ title, children, actions, backLabel, onBack, hideHeader = false }: GlobalPageLayoutProps) {
  const navigate = useNavigate();
  const { t } = useTranslation('common');

  const handleBack = () => {
    if (onBack) { onBack(); return; }
    const stored = localStorage.getItem('workspace-active-project');
    const wsMatch = matchWorkspacePath(window.location.pathname);
    const projectId = wsMatch?.id ?? stored ?? '1';
    navigate(paths.workspace(projectId));
  };

  return (
    <div className="ws-surface" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--ws-surface)' }}>
      {!hideHeader && (
        <header style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
          padding: '0 var(--space-4)',
          height: 48, minHeight: 48,
          borderBottom: '1px solid var(--border)',
          background: 'var(--ws-surface-card)',
        }}>
          <button
            onClick={handleBack}
            aria-label={backLabel ?? t('globalPages.backToWorkspace')}
            className="row-hover"
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-1)',
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--text-dim)', fontSize: 'var(--font-sm)',
              padding: '4px 8px', borderRadius: 'var(--radius-sm)',
              transition: 'color 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; }}
          >
            <Icon name="chevron-left" size={16} />
            <span className="global-page-back-label">{backLabel ?? t('globalPages.workspace')}</span>
          </button>
          <h1 style={{
            margin: 0, fontSize: 'var(--font-md)', fontWeight: 600,
            color: 'var(--text)', whiteSpace: 'nowrap',
          }}>
            {title}
          </h1>
          {actions && <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--space-2)' }}>{actions}</div>}
        </header>
      )}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {children}
      </div>
      <style>{`
        @media (max-width: 768px) {
          .global-page-back-label { display: none; }
        }
      `}</style>
    </div>
  );
}
