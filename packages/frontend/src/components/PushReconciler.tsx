import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ensurePushSubscription } from '../utils/pushNotifications';

export function PushReconciler() {
  const { i18n } = useTranslation();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const lang = i18n.resolvedLanguage === 'ja' ? 'ja' : 'en';
    ensurePushSubscription(lang).catch((err) => console.warn('[PushReconciler]', err));
  }, [i18n]);

  return null;
}
