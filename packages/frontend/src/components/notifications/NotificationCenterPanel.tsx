import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { notificationIcon, useNotificationCenter } from '../../hooks/useNotificationCenter';
import type { AppNotification } from '../../types/notification';
import { formatRelativeTime } from '../../utils/time';

type NotificationCenterPanelAnchor = { top: number; left: number } | 'fullscreen';

interface NotificationCenterPanelProps {
  anchor: NotificationCenterPanelAnchor;
  onClose: () => void;
}

export const NOTIFICATION_PANEL_WIDTH = 340;

function NotificationRow({ notification, onSelect }: { notification: AppNotification; onSelect: () => void }) {
  const { t } = useTranslation('notifications');
  return (
    <button
      onClick={onSelect}
      className="notification-row"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-2)',
        width: '100%',
        padding: 'var(--space-2) var(--space-3)',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        background: notification.read ? 'transparent' : 'var(--selected-bg)',
        color: 'var(--text)',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 'var(--font-lg)', lineHeight: 1.3 }}>{notificationIcon(notification.kind)}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 'var(--font-sm)', fontWeight: notification.read ? 400 : 600, lineHeight: 1.4 }}>
          {notification.messageKey ? t(notification.messageKey, notification.messageParams) : (notification.title ?? '')}
        </span>
        <span style={{ display: 'block', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
          {formatRelativeTime(notification.createdAt)}
        </span>
      </span>
      {!notification.read && (
        <span
          aria-hidden="true"
          style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: 'var(--accent)', marginTop: 4, flexShrink: 0 }}
        />
      )}
    </button>
  );
}

export function NotificationCenterPanel({ anchor, onClose }: NotificationCenterPanelProps) {
  const { t } = useTranslation('notifications');
  const { notifications, unreadCount, markAllRead, clear, openNotification } = useNotificationCenter();

  const isFullscreen = anchor === 'fullscreen';

  const horizontalStyle: React.CSSProperties = isFullscreen
    ? { inset: 0, width: '100%', maxWidth: '100%' }
    : (() => {
      const maxLeft = typeof window !== 'undefined' ? window.innerWidth - NOTIFICATION_PANEL_WIDTH - 8 : anchor.left;
      const left = Math.max(8, Math.min(anchor.left, maxLeft));
      return { left, width: NOTIFICATION_PANEL_WIDTH, maxWidth: 'calc(100vw - 16px)' };
    })();

  const verticalStyle: React.CSSProperties = isFullscreen
    ? { inset: 0, maxHeight: '100%' }
    : (() => {
      const maxTop = typeof window !== 'undefined' ? window.innerHeight - 8 : anchor.top;
      const top = Math.min(anchor.top, maxTop - 100);
      return { top, maxHeight: 'calc(100vh - 32px)' };
    })();

  const handleSelect = (notification: AppNotification) => {
    openNotification(notification);
    onClose();
  };

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

  // Fullscreen (mobile) mode is rendered outside any outside-close wrapper, so
  // provide Escape as the keyboard close path alongside the in-panel ✕ button.
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, onClose]);

  return (
    <div
      role="dialog"
      aria-label={t('center.ariaLabel')}
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 300,
        ...horizontalStyle,
        ...verticalStyle,
        borderRadius: isFullscreen ? 0 : 'var(--radius-lg)',
        background: 'var(--bg-elevated)',
        border: isFullscreen ? 'none' : '1px solid var(--border)',
        boxShadow: isFullscreen ? 'none' : '0 12px 36px rgba(0, 0, 0, 0.5)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-2) var(--space-3)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)' }}>{t('center.title')}</span>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button
            onClick={markAllRead}
            disabled={unreadCount === 0}
            className="notification-panel-action"
            style={{
              background: 'none', border: 'none', cursor: unreadCount === 0 ? 'default' : 'pointer',
              color: unreadCount === 0 ? 'var(--text-dim)' : 'var(--accent)',
              fontSize: 'var(--font-xs)', opacity: unreadCount === 0 ? 0.5 : 1, padding: 0,
            }}
          >
            {t('center.markAllRead')}
          </button>
          <button
            onClick={clear}
            disabled={notifications.length === 0}
            className="notification-panel-action"
            style={{
              background: 'none', border: 'none', cursor: notifications.length === 0 ? 'default' : 'pointer',
              color: notifications.length === 0 ? 'var(--text-dim)' : 'var(--text-dim)',
              fontSize: 'var(--font-xs)', opacity: notifications.length === 0 ? 0.5 : 1, padding: 0,
            }}
          >
            {t('center.clear')}
          </button>
          {isFullscreen && (
            <button
              onClick={onClose}
              aria-label={t('center.closeAriaLabel')}
              className="notification-panel-action"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 24, height: 24, background: 'var(--bg)', border: 'none',
                borderRadius: 'var(--radius-md)', cursor: 'pointer', color: 'var(--text-dim)',
                padding: 0,
              }}
            >
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
      </div>

      <div style={{ flex: 1, background: 'var(--bg)', overflowY: 'auto', padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {notifications.length === 0 ? (
          <EmptyState title={t('center.empty')} description={t('center.emptyDescription')} />
        ) : (
          notifications.map((n) => (
            <NotificationRow key={n.id} notification={n} onSelect={() => handleSelect(n)} />
          ))
        )}
      </div>
    </div>
  );
}
