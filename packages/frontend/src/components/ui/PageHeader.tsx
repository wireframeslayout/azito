import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../../hooks/useIsMobile';
import ContextMenu, { useContextMenu } from '../ContextMenu';
import { Button } from './Button';
import { Icon } from './Icon';

export interface PageHeaderAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
}

interface PageHeaderPrimaryAction {
  label: string;
  /** SP表示時のラベル。省略時は "+ New" */
  shortLabel?: string;
  onClick: () => void;
}

interface PageHeaderProps {
  title: string;
  /** タイトル横に表示する件数 */
  count?: number;
  primaryAction?: PageHeaderPrimaryAction;
  secondaryActions?: PageHeaderAction[];
  /** 検索ボックス等。PCはアクション左にinline、SPはヘッダー下の全幅行 */
  children?: ReactNode;
}

const moreButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: 'var(--font-lg)',
  lineHeight: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

/**
 * 一覧ページ共通のヘッダー（PageContainer直下に配置）。
 * PC: title+count / secondaryActions / primaryAction を1行に横並び。
 * SP: primaryActionは常時表示（shortLabel）、secondaryActionsは⋮メニューに格納。
 * children（検索UI等）はPCでアクション左にinline、SPでは下段の全幅行。
 */
export function PageHeader({ title, count, primaryAction, secondaryActions, children }: PageHeaderProps) {
  const { t } = useTranslation('common');
  const isMobile = useIsMobile();
  const { menu, show, hide } = useContextMenu();

  const hasSecondary = !!secondaryActions?.length;

  const openMoreMenu = (e: MouseEvent<HTMLButtonElement>) => {
    show(
      e,
      (secondaryActions ?? []).map((a) => ({ label: a.label, icon: a.icon, onClick: a.onClick })),
    );
  };

  const titleBlock = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0, flex: 1 }}>
      <h1
        style={{
          fontSize: isMobile ? 'var(--font-xl)' : 'var(--font-xl)',
          fontWeight: 700,
          margin: 0,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </h1>
      {count !== undefined && (
        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', flexShrink: 0 }}>{count}</span>
      )}
    </div>
  );

  const primaryButton = primaryAction && (
    <Button
      variant="primary"
      onClick={primaryAction.onClick}
      style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
    >
      {isMobile ? (primaryAction.shortLabel ?? t('actions.new')) : primaryAction.label}
    </Button>
  );

  if (isMobile) {
    return (
      <div style={{ padding: '14px 12px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {titleBlock}
          {hasSecondary && (
            <button
              type="button"
              onClick={openMoreMenu}
              aria-label={t('navigation.moreActions')}
              aria-haspopup="menu"
              className="icon-btn"
              style={moreButtonStyle}
            >
              <Icon name="more" size={14} />
            </button>
          )}
          {primaryButton}
        </div>
        {children && <div style={{ marginTop: 10, width: '100%' }}>{children}</div>}
        {menu && <ContextMenu menu={menu} onClose={hide} />}
      </div>
    );
  }

  return (
    <div style={{ padding: '18px 20px 14px', display: 'flex', alignItems: 'center', gap: 16 }}>
      {titleBlock}
      {children && <div style={{ flexShrink: 0 }}>{children}</div>}
      {hasSecondary && (
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {secondaryActions!.map((a, i) => (
            <Button key={i} onClick={a.onClick} style={{ whiteSpace: 'nowrap' }}>
              {a.icon}
              {a.icon ? ' ' : ''}
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {primaryButton}
    </div>
  );
}
