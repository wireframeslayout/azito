import { api } from '../api/client';

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

export async function subscribeToPush(registration: ServiceWorkerRegistration, lang = 'en'): Promise<PushSubscription | null> {
  try {
    const { publicKey } = await api<{ publicKey?: string }>('/notifications/vapid-public-key');
    if (!publicKey) return null;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    });

    const subJson = subscription.toJSON();
    const result = await api<{ ok?: boolean; error?: string }>('/notifications/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subJson.keys?.p256dh || '',
          auth: subJson.keys?.auth || '',
        },
        lang,
      }),
    });
    if (!result.ok) {
      console.error('Subscribe API failed:', result.error ?? 'unknown error');
      return null;
    }

    return subscription;
  } catch (err) {
    console.error('Push subscribe error:', err);
    return null;
  }
}

export async function unsubscribeFromPush(registration: ServiceWorkerRegistration): Promise<void> {
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await api('/notifications/unsubscribe', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => {
        // サーバー削除の失敗はローカル解除を妨げない
      });
      await subscription.unsubscribe();
    }
  } catch {
    // Silently ignore errors during unsubscribe
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export async function syncPushLanguage(lang: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const subJson = subscription.toJSON();
    await api('/notifications/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subJson.keys?.p256dh || '',
          auth: subJson.keys?.auth || '',
        },
        lang: lang === 'ja' ? 'ja' : 'en',
      }),
    });
  } catch (err) {
    console.warn('[Push] syncPushLanguage failed:', err);
  }
}
