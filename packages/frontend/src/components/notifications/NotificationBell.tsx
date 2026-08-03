import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationCenter } from '../../hooks/useNotificationCenter';
import { NotificationCenterPanel } from './NotificationCenterPanel';
import { Icon } from '../ui/Icon';

/**
 * ProjectSidebar のレール上に置く通知ベル。未読数バッジ付きボタン＋アンカー式ポップオーバー。
 * UsageDropdown と同様、自前で開閉状態とパネル位置を管理する（GlassPopover はモバイルの
 * フローティングメニュー専用のボトムシート的な配置のため、この用途では使わない）。
 */
export default function NotificationBell() {
  const { t } = useTranslation('notifications');
  const { unreadCount } = useNotificationCenter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPanelPos({ top: rect.top, left: rect.right + 8 });
    }
    setOpen((v) => !v);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unreadCount > 0 ? t('bell.ariaLabelUnread', { count: unreadCount }) : t('bell.ariaLabel')}
        title={t('bell.ariaLabel')}
        style={{
          width: 36, height: 36, minHeight: 36, borderRadius: 'var(--radius-md)', border: 'none', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
          position: 'relative',
          background: open ? 'var(--selected-bg-strong)' : 'transparent',
          color: 'var(--text-dim)',
          transition: 'background 0.15s ease, color 0.15s ease',
        }}
        className="notification-bell-btn"
      >
        <Icon name="bell" size={16} />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute', top: 2, right: 2,
              minWidth: 16, height: 16, borderRadius: 'var(--radius-full)',
              background: 'var(--danger)', color: '#fff', // lint-allow: hex - white text on solid danger fill; no on-color token yet
              fontSize: 'var(--font-2xs)', fontWeight: 700, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 3px',
              boxShadow: '0 0 0 2px var(--bg-card)',
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <NotificationCenterPanel
          anchor={panelPos}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
