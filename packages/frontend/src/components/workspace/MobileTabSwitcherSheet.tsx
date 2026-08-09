import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { EmptyState } from '../ui/EmptyState';
import type { TabItem } from '../ui';
import type { PersistedTab } from '../../hooks/useTabPersistence';

interface ProjectItem {
  id: number;
  name: string;
  color?: string;
}

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
}

interface TabGroup {
  projectId: number | null;
  name: string;
  color?: string;
  items: Array<{ tab: PersistedTab; item: TabItem }>;
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

  const groups = useMemo<TabGroup[]>(() => {
    const byProject = new Map<number | null, TabGroup>();
    for (const tab of tabs) {
      const projectId = tab.projectId ?? null;
      let group = byProject.get(projectId);
      if (!group) {
        const project = projectId != null ? allProjects.find((p) => p.id === projectId) : undefined;
        group = {
          projectId,
          name: project?.name ?? t('mobile.tabSwitcherUngrouped'),
          color: project?.color,
          items: [],
        };
        byProject.set(projectId, group);
      }
      group.items.push({ tab, item: buildTabItem(tab) });
    }
    // Order: groups matching a known project follow allProjects' order (stable,
    // predictable position across renders); the ungrouped bucket (no projectId)
    // always trails since it has no natural ordering key of its own.
    const ordered: TabGroup[] = [];
    for (const p of allProjects) {
      const g = byProject.get(p.id);
      if (g) ordered.push(g);
    }
    const ungrouped = byProject.get(null);
    if (ungrouped) ordered.push(ungrouped);
    return ordered;
  }, [tabs, allProjects, buildTabItem, t]);

  if (!shouldRender) return null;

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
        {groups.length === 0 ? (
          <EmptyState title={t('mobile.tabSwitcherEmpty')} />
        ) : (
          groups.map((group) => (
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
                <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>{group.items.length}</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                {group.items.map(({ tab, item }) => {
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
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                        <span style={{ display: 'inline-flex', color: isActive ? 'var(--accent)' : 'var(--text-dim)' }}>{item.icon}</span>
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
                })}
              </div>
            </div>
          ))
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
