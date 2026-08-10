import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/EmptyState';
import type { TabItem } from '../ui';
import type { PersistedTab } from '../../hooks/useTabPersistence';
import { buildTabGroups, buildPinnedItems, type TabGroupProjectItem, type TabGroupItem } from './mobileTabGroups';

type ProjectItem = TabGroupProjectItem;

interface MobileTabSwitcherSheetProps {
  open: boolean;
  onClose: () => void;
  tabs: PersistedTab[];
  activeTabId: string | null;
  allProjects: ProjectItem[];
  buildTabItem: (tab: PersistedTab) => TabItem;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onOpenAddTab: () => void;
  onTogglePin: (tabId: string) => void;
}

/** 44px tap target pin toggle, shared by the pinned section rows and the project-group cards. */
function PinToggleButton({ pinned, onToggle, t }: { pinned: boolean; onToggle: () => void; t: (key: string) => string }) {
  return (
    <span
      role="button"
      aria-label={pinned ? t('mobile.unpinTab') : t('mobile.pinTab')}
      aria-pressed={pinned}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className="icon-btn"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 44,
        height: 44,
        margin: '-10px -8px -10px 0',
        color: pinned ? 'var(--accent)' : 'var(--text-dim)',
        borderRadius: 'var(--radius-sm)',
        flexShrink: 0,
      }}
    >
      <Icon name="pin" size={16} />
    </span>
  );
}

/**
 * SP専用のフルスクリーンタブスイッチャー（Issue #69 Phase E-3）。開いている
 * タブをプロジェクトごとにグループ化してカード表示する。タブの並べ替え
 * D&D は既存デスクトップ機能のみ維持しスコープ外、ライブ状態表示（実行中
 * インジケータ等）もスコープ外 — 将来ウィンドウ→セッション解決の一括
 * ポーリングが必要になった時点で追加する。
 */
export function MobileTabSwitcherSheet({
  open,
  onClose,
  tabs,
  activeTabId,
  allProjects,
  buildTabItem,
  onSelectTab,
  onCloseTab,
  onOpenAddTab,
  onTogglePin,
}: MobileTabSwitcherSheetProps) {
  const { t } = useTranslation('workspace');
  const [shouldRender, setShouldRender] = useState(open);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      return;
    }
    const timer = window.setTimeout(() => setShouldRender(false), 200);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  const groups = useMemo(
    () => buildTabGroups(tabs, allProjects, buildTabItem, t('mobile.tabSwitcherUngrouped')),
    [tabs, allProjects, buildTabItem, t],
  );
  const pinnedItems = useMemo(
    () => buildPinnedItems(tabs, allProjects, buildTabItem),
    [tabs, allProjects, buildTabItem],
  );

  if (!shouldRender) return null;

  const renderCard = ({ tab, item }: TabGroupItem) => {
    const isActive = tab.id === activeTabId;
    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => { onSelectTab(tab.id); onClose(); }}
        className="row-hover"
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 8,
          padding: '10px 10px 8px',
          minHeight: 76,
          borderRadius: 'var(--radius-lg)',
          border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
          background: isActive ? 'var(--accent-a08)' : 'var(--bg-card)',
          color: 'var(--text)',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 4 }}>
          <span style={{ display: 'inline-flex', color: isActive ? 'var(--accent)' : 'var(--text-dim)', flex: 1 }}>{item.icon}</span>
          <PinToggleButton pinned={!!tab.pinned} onToggle={() => onTogglePin(tab.id)} t={t} />
          {item.closable !== false && (
            <span
              role="button"
              aria-label={t('windows.closeTab')}
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              className="icon-btn"
              style={{ display: 'inline-flex', color: 'var(--text-dim)', padding: 4, borderRadius: 'var(--radius-sm)' }}
            >
              <Icon name="close" size={14} />
            </span>
          )}
        </span>
        <span style={{
          fontSize: 'var(--font-sm)', lineHeight: 1.3,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {item.label}
        </span>
      </button>
    );
  };

  const renderPinnedRow = ({ tab, item, color }: TabGroupItem) => {
    const isActive = tab.id === activeTabId;
    return (
      <button
        key={tab.id}
        type="button"
        onClick={() => { onSelectTab(tab.id); onClose(); }}
        className="row-hover"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '9px 8px',
          marginBottom: 6,
          borderRadius: 'var(--radius-md)',
          border: `1px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
          background: isActive ? 'var(--accent-a08)' : 'var(--bg-card)',
          color: 'var(--text)',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span aria-hidden="true" style={{
          width: 8, height: 8, borderRadius: 'var(--radius-full)',
          background: color || 'var(--border)', flexShrink: 0,
        }} />
        <span style={{ display: 'inline-flex', color: isActive ? 'var(--accent)' : 'var(--text-dim)', flexShrink: 0 }}>{item.icon}</span>
        <span style={{
          flex: 1, minWidth: 0, fontSize: 'var(--font-sm)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {item.label}
        </span>
        <PinToggleButton pinned onToggle={() => onTogglePin(tab.id)} t={t} />
        {item.closable !== false && (
          <span
            role="button"
            aria-label={t('windows.closeTab')}
            onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
            className="icon-btn"
            style={{ display: 'inline-flex', color: 'var(--text-dim)', padding: 4, borderRadius: 'var(--radius-sm)', flexShrink: 0 }}
          >
            <Icon name="close" size={14} />
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('mobile.tabSwitcherTitle')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 140,
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        opacity: open ? 1 : 0,
        transform: open ? 'translateY(0)' : 'translateY(12px)',
        transition: 'opacity 0.2s ease, transform 0.2s ease',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 12px calc(10px + env(safe-area-inset-top))',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--text)', flex: 1 }}>
          {t('mobile.tabSwitcherTitle')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('mobile.tabSwitcherClose')}
          className="icon-btn"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 36, height: 36, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated)', color: 'var(--text-dim)', cursor: 'pointer',
          }}
        >
          <Icon name="close" size={20} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 16px' }}>
        {groups.length === 0 && pinnedItems.length === 0 ? (
          <EmptyState title={t('mobile.tabSwitcherEmpty')} />
        ) : (
          <>
            {pinnedItems.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '4px 4px 8px',
                }}>
                  <Icon name="pin" size={14} />
                  <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>
                    {t('mobile.tabSwitcherPinnedSection')}
                  </span>
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{pinnedItems.length}</span>
                </div>
                {pinnedItems.map(renderPinnedRow)}
              </div>
            )}

            {groups.map((group) => (
              <div key={group.projectId ?? 'ungrouped'} style={{ marginTop: 16 }}>
                <div style={{
                  position: 'sticky', top: 0, zIndex: 1,
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 4px', background: 'var(--bg)',
                }}>
                  <span aria-hidden="true" style={{
                    width: 9, height: 9, borderRadius: 'var(--radius-full)',
                    background: group.color || 'var(--border)', flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>{group.name}</span>
                  <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{group.totalCount}</span>
                </div>

                {group.items.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                    {group.items.map(renderCard)}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div style={{ padding: '10px 12px calc(10px + env(safe-area-inset-bottom))', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button
          type="button"
          onClick={() => { onOpenAddTab(); onClose(); }}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '11px 0', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            background: 'var(--bg-elevated)', color: 'var(--text)', fontSize: 'var(--font-sm)', fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Icon name="plus" size={16} />
          {t('mobile.tabSwitcherNewTab')}
        </button>
      </div>
    </div>
  );
}
