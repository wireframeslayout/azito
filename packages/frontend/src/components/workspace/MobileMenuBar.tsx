import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MobileKeyboardOverlay } from '../ui/MobileKeyboardOverlay';
import { useVirtualKeyboard } from '../../hooks/useVirtualKeyboard';
import { useNotificationCenter } from '../../hooks/useNotificationCenter';
import { NotificationCenterPanel } from '../notifications/NotificationCenterPanel';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { MobileActiveWindowsPanel } from './MobileActiveWindowsPanel';
import { Icon } from '../ui/Icon';
import { MobileGlobalMenuSheet } from './MobileGlobalMenuSheet';
import { getHealthLevel, getWorstHealth, useServerResourcesContext } from '../../hooks/useServerResources';
import { ResourceDropdownContent } from '../statusbar/ResourceDropdown';
import { BottomSheet } from '../ui/BottomSheet';

export interface MobileMenuBarProps {
  /** Total number of open tabs, shown as a badge on the "タブ" item. */
  tabCount: number;
  /** Deselects the active tab (returns to the home/empty-tab state). No-op when already home. */
  onGoHome: () => void;
  /** Opens the full-screen tab switcher sheet (Issue #69 Phase E-3). */
  onOpenTabSwitcher: () => void;
  /** Opens the "add tab" entry point (existing add-window flow). */
  onOpenAddTab: () => void;
  onSendKey?: (key: string) => void;
  hidden?: boolean;
  connectPane?: (serverName: string, target: string, projectId?: number) => void;
  openTask?: (taskId: number, title: string, projectId?: number) => void;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

type OpenPopover = 'notifications' | 'activeWindows' | 'other' | 'health' | null;

const ICON_SIZE = 20;

/**
 * SP下部バー（Issue #69 修正4 / 承認済み S1 提案）。旧アイコン群（プロジェクト/モード切替 +
 * keyboard/monitor/bell/…）を、ラベル付き5項目 [ホーム/タブ/追加/通知/その他] へ刷新する。
 * プロジェクト・表示モード切替は既存の SP サイドバー導線（MobileTabChipRow の ☰ →
 * WorkspaceLayout のドロワー、常設）に委ねるため、ここでは扱わない — 機能の削除ではなく、
 * 既存の別導線への集約。keyboard/アクティブウィンドウ/サーバーヘルスは「その他」シート
 * （MobileGlobalMenuSheet 拡張）へ退避し、機能自体は失わない。
 */
export function MobileMenuBar({
  tabCount,
  onGoHome,
  onOpenTabSwitcher,
  onOpenAddTab,
  onSendKey,
  hidden,
  connectPane,
  openTask,
  taskWindows,
}: MobileMenuBarProps) {
  const { t } = useTranslation('workspace');
  const keyboardVisible = useVirtualKeyboard();
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const [keyboardOverlayOpen, setKeyboardOverlayOpen] = useState(false);
  const { unreadCount } = useNotificationCenter();
  const { rows: awRows, totalCount: awCount, blockedCount: awBlockedCount } = useActiveWindowRows();
  const hasWorking = awRows.some((r) => r.status === 'running' && r.activityStatus !== 'blocked');
  const servers = useServerResourcesContext();
  const worstHealth = getWorstHealth(servers.map((s) => getHealthLevel(s.measurement)));
  const otherNeedsAttention = hasWorking || awBlockedCount > 0 || worstHealth === 'critical' || worstHealth === 'warning';

  const togglePopover = (name: OpenPopover) => setOpenPopover((prev) => (prev === name ? null : name));
  const closePopover = () => setOpenPopover(null);

  useEffect(() => {
    if (keyboardVisible || hidden) setOpenPopover(null);
  }, [keyboardVisible, hidden]);

  useEffect(() => {
    if (keyboardVisible || hidden) setKeyboardOverlayOpen(false);
  }, [keyboardVisible, hidden]);

  const itemStyle: React.CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    minHeight: 44,
    padding: '4px 2px',
    border: 'none',
    background: 'none',
    color: 'var(--text-dim)',
    cursor: 'pointer',
    position: 'relative',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--font-2xs)',
    fontWeight: 500,
    lineHeight: 1,
  };

  return (
    <>
      <nav
        aria-label={t('mobile.mobileMenu')}
        className={`mobile-menu-bar${keyboardVisible || hidden ? ' mobile-menu-bar-hidden' : ''}`}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          paddingBottom: 'env(safe-area-inset-bottom)',
          display: 'flex',
          background: 'var(--bg-solid)',
          borderTop: '1px solid var(--border)',
          zIndex: 120,
        }}
      >
        <button type="button" className="mobile-menu-bar-item" style={itemStyle} onClick={onGoHome} title={t('mobile.home')} aria-label={t('mobile.home')}>
          <Icon name="home" size={ICON_SIZE} />
          <span style={labelStyle}>{t('mobile.home')}</span>
        </button>

        <button
          type="button"
          className="mobile-menu-bar-item"
          style={itemStyle}
          onClick={onOpenTabSwitcher}
          title={t('mobile.tabs')}
          aria-label={t('mobile.tabSwitcherOpen', { count: tabCount })}
        >
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Icon name="windows" size={ICON_SIZE} />
            {tabCount > 0 && (
              <span aria-hidden="true" className="mi-btn-badge">{tabCount > 99 ? '99+' : tabCount}</span>
            )}
          </span>
          <span style={labelStyle}>{t('mobile.tabs')}</span>
        </button>

        <button type="button" className="mobile-menu-bar-item" style={itemStyle} onClick={onOpenAddTab} title={t('mobile.add')} aria-label={t('mobile.add')}>
          <Icon name="plus" size={ICON_SIZE} />
          <span style={labelStyle}>{t('mobile.add')}</span>
        </button>

        <button
          type="button"
          className="mobile-menu-bar-item"
          style={{ ...itemStyle, color: openPopover === 'notifications' ? 'var(--accent)' : itemStyle.color }}
          onClick={() => togglePopover('notifications')}
          aria-haspopup="dialog"
          aria-expanded={openPopover === 'notifications'}
          title={t('mobile.notifications')}
          aria-label={unreadCount > 0 ? t('mobile.notificationsUnread', { count: unreadCount }) : t('mobile.notifications')}
        >
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Icon name="bell" size={ICON_SIZE} />
            {unreadCount > 0 && (
              <span aria-hidden="true" className="mi-btn-badge mi-btn-badge-alert">{unreadCount > 99 ? '99+' : unreadCount}</span>
            )}
          </span>
          <span style={labelStyle}>{t('mobile.notifications')}</span>
        </button>

        <button
          type="button"
          className="mobile-menu-bar-item"
          style={{ ...itemStyle, color: openPopover === 'other' ? 'var(--accent)' : itemStyle.color }}
          onClick={() => togglePopover('other')}
          aria-haspopup="dialog"
          aria-expanded={openPopover === 'other'}
          title={t('mobile.other')}
          aria-label={t('mobile.other')}
        >
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Icon name="menu" size={ICON_SIZE} />
            {otherNeedsAttention && (
              <span aria-hidden="true" style={{
                position: 'absolute', top: -2, right: -2, width: 8, height: 8, borderRadius: 'var(--radius-full)',
                background: awBlockedCount > 0 || worstHealth === 'critical' ? 'var(--danger)' : 'var(--warning)',
                border: '1.5px solid var(--bg-solid)',
              }} />
            )}
          </span>
          <span style={labelStyle}>{t('mobile.other')}</span>
        </button>
      </nav>

      {openPopover === 'notifications' && <NotificationCenterPanel anchor="fullscreen" onClose={closePopover} />}

      <MobileGlobalMenuSheet
        open={openPopover === 'other'}
        onClose={closePopover}
        onOpenKeyboard={() => { closePopover(); setKeyboardOverlayOpen(true); }}
        activeWindowsCount={awCount}
        activeWindowsBlockedCount={awBlockedCount}
        onOpenActiveWindows={connectPane && openTask ? () => setOpenPopover('activeWindows') : undefined}
        serverHealth={worstHealth}
        onOpenServerHealth={() => setOpenPopover('health')}
      />

      {openPopover === 'activeWindows' && connectPane && openTask && (
        <MobileActiveWindowsPanel
          onClose={closePopover}
          connectPane={connectPane}
          openTask={openTask}
          taskWindows={taskWindows ?? []}
        />
      )}
      {keyboardOverlayOpen && (
        <MobileKeyboardOverlay onSendKey={(key) => onSendKey?.(key)} onClose={() => setKeyboardOverlayOpen(false)} />
      )}
      <BottomSheet open={openPopover === 'health'} onClose={closePopover} title={t('mobile.serverHealth')}>
        {servers.map((s) => (
          <ResourceDropdownContent
            key={s.serverName}
            serverName={s.serverName}
            health={getHealthLevel(s.measurement)}
            meterWidth={90}
          />
        ))}
      </BottomSheet>
    </>
  );
}
