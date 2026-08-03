import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import { registerServiceWorker, subscribeToPush, unsubscribeFromPush } from '../../../utils/pushNotifications';
import { Button, LoadingState } from '../../ui';

export default function NotificationsSection() {
  const { t, i18n } = useTranslation('settings');
  const [browserAutoOpen, setBrowserAutoOpen] = useState(() => localStorage.getItem('browser-auto-open') === 'true');
  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    const check = async () => {
      const isSupported = 'serviceWorker' in navigator && 'PushManager' in window;
      setSupported(isSupported);
      if ('Notification' in window) setPermission(Notification.permission);
      if (isSupported) {
        try {
          const reg = await navigator.serviceWorker?.ready;
          const sub = await reg?.pushManager?.getSubscription();
          setSubscribed(!!sub);
        } catch { /* */ }
      }
      setLoading(false);
    };
    check();
  }, []);

  const handleSubscribe = useCallback(async () => {
    setActionLoading(true);
    try {
      const reg = await registerServiceWorker();
      if (!reg) return;
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return;
      const sub = await subscribeToPush(reg, i18n.resolvedLanguage === 'ja' ? 'ja' : 'en');
      setSubscribed(!!sub);
    } finally {
      setActionLoading(false);
    }
  }, [i18n]);

  const handleUnsubscribe = useCallback(async () => {
    setActionLoading(true);
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg) await unsubscribeFromPush(reg);
      setSubscribed(false);
    } finally {
      setActionLoading(false);
    }
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api<{ ok?: boolean; sent?: number; error?: string }>('/notifications/test', { method: 'POST' });
      setTestResult(res.ok ? `Sent to ${res.sent} device(s)` : res.error || 'Failed to send');
    } catch {
      setTestResult('Failed to send');
    } finally {
      setTesting(false);
    }
  }, []);

  if (loading) return <LoadingState />;
  if (!supported) {
    return (
      <div>
        <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', lineHeight: 1.5 }}>
          {t('notifications.notSupported')}
        </p>
      </div>
    );
  }

  return (
    <div>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 20, lineHeight: 1.5 }}>
        {t('notifications.description')}
      </p>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 'var(--font-base)', fontWeight: 600, marginBottom: 4 }}>{t('notifications.title')}</div>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
              {subscribed ? t('notifications.subscribed') : t('notifications.notSubscribed')}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {subscribed && (
              <Button size="sm" onClick={handleTest} loading={testing} loadingLabel={t('notifications.sending')}>
                {t('notifications.sendTest')}
              </Button>
            )}
            {subscribed ? (
              <Button variant="danger" size="sm" onClick={handleUnsubscribe} loading={actionLoading} loadingLabel={t('notifications.unsubscribing')}>
                {t('notifications.unsubscribe')}
              </Button>
            ) : (
              <Button variant="primary" size="sm" onClick={handleSubscribe} loading={actionLoading} loadingLabel={t('notifications.subscribing')}>
                {t('notifications.subscribe')}
              </Button>
            )}
          </div>
        </div>
        {testResult && (
          <div style={{ fontSize: 'var(--font-sm)', color: testResult.startsWith('Sent') ? 'var(--success)' : 'var(--danger)', marginTop: 8 }}>
            {testResult}
          </div>
        )}
        {permission === 'denied' && (
          <div style={{ fontSize: 'var(--font-sm)', color: 'var(--danger)', marginTop: 8 }}>
            {t('notifications.blocked')}
          </div>
        )}
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: 12, lineHeight: 1.6 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('notifications.events')}</div>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>{t('notifications.eventTaskCompleted')}</li>
            <li>{t('notifications.eventTaskFailed')}</li>
          </ul>
        </div>
      </div>
      <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20, marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 'var(--font-base)', fontWeight: 600, marginBottom: 4 }}>{t('notifications.browserAutoOpen')}</div>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
              {t('notifications.browserAutoOpenDescription')}
            </div>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={browserAutoOpen}
              onChange={(e) => {
                const v = e.target.checked;
                setBrowserAutoOpen(v);
                localStorage.setItem('browser-auto-open', String(v));
              }}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </div>
  );
}
