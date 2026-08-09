import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import type { TabItem } from '../ui';

interface MobileTabChipRowProps {
  activeTab: TabItem | null;
  tabCount: number;
  onOpenSwitcher: () => void;
  onOpenMenu: () => void;
}

/**
 * SP専用の常設タブチップ行（Issue #69 Phase E-3）。デスクトップ／SPともに同じ
 * useTabPersistence ストアを共有し、この行は「現在アクティブなタブの表示」と
 * 「タブスイッチャー（フルスクリーンシート）を開く導線」のみを担う — タブの
 * 開閉・並べ替え自体は既存ストアの操作（selectTab/closeTab等）が引き続き担当する。
 * 左ボーダー/左エッジでの色分けは禁止のため、プロジェクト色は丸ドットのみで示す。
 */
export function MobileTabChipRow({ activeTab, tabCount, onOpenSwitcher, onOpenMenu }: MobileTabChipRowProps) {
  const { t } = useTranslation('workspace');

  return (
    <div
      className="ws-surface"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 8px',
        minHeight: 44,
        borderBottom: '1px solid var(--border)',
        background: 'var(--ws-surface-card)',
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={onOpenSwitcher}
        aria-label={t('mobile.tabSwitcherOpen', { count: tabCount })}
        className="icon-btn"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          flexShrink: 0,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-elevated)',
          color: 'var(--text)',
          padding: '5px 8px',
          minHeight: 32,
          cursor: 'pointer',
        }}
      >
        <Icon name="windows" size={16} />
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, minWidth: 10, textAlign: 'center' }}>{tabCount}</span>
      </button>

      <button
        type="button"
        onClick={onOpenSwitcher}
        aria-label={t('mobile.tabSwitcherOpen', { count: tabCount })}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'none',
          border: 'none',
          padding: '6px 4px',
          margin: 0,
          cursor: 'pointer',
          color: 'var(--text)',
          textAlign: 'left',
        }}
      >
        {activeTab ? (
          <>
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: 'var(--radius-full)',
                background: activeTab.projectColor || 'var(--border)',
                flexShrink: 0,
              }}
            />
            {activeTab.icon != null && <span style={{ display: 'inline-flex', flexShrink: 0 }}>{activeTab.icon}</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-sm)' }}>
              {activeTab.label}
            </span>
            {activeTab.extra}
          </>
        ) : (
          <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('mobile.noTabSelected')}</span>
        )}
      </button>

      <button
        type="button"
        onClick={onOpenMenu}
        aria-label={t('mobile.menu')}
        className="icon-btn"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 36,
          height: 36,
          border: 'none',
          background: 'none',
          color: 'var(--text-dim)',
          cursor: 'pointer',
        }}
      >
        <Icon name="menu" size={20} />
      </button>
    </div>
  );
}
