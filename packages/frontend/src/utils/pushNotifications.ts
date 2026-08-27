import { api } from '../api/client';

// ── opt-in persistence ──

interface PushOptInState {
  enabled: true;
  vapidPublicKey: string;
  pendingResubscribe?: boolean;
}

const OPT_IN_KEY = 'azito_push_optin';

function saveOptIn(state: PushOptInState): void {
  localStorage.setItem(OPT_IN_KEY, JSON.stringify(state));
}

function loadOptIn(): PushOptInState | null {
  try {
    return JSON.parse(localStorage.getItem(OPT_IN_KEY) ?? 'null');
  } catch {
    return null;
  }
}

function clearOptIn(): void {
  localStorage.removeItem(OPT_IN_KEY);
}

// ── encoding helpers ──

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function uint8ToUrlBase64(arr: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── shared POST helper ──

async function postSubscription(sub: PushSubscription, lang: string): Promise<void> {
  const subJson = sub.toJSON();
  const result = await api<{ ok?: boolean; error?: string }>('/notifications/subscribe', {
    method: 'POST',
    body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: {
        p256dh: subJson.keys?.p256dh || '',
        auth: subJson.keys?.auth || '',
      },
      lang,
    }),
  });
  if (!result.ok) {
    throw new Error(result.error ?? 'Subscribe API failed');
  }
}

// ── public API ──

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

    await postSubscription(subscription, lang);
    saveOptIn({ enabled: true, vapidPublicKey: publicKey });
    return subscription;
  } catch (err) {
    console.error('Push subscribe error:', err);
    return null;
  }
}

export async function unsubscribeFromPush(registration: ServiceWorkerRegistration): Promise<void> {
  clearOptIn();
  try {
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await api('/notifications/unsubscribe', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }).catch(() => {});
      await subscription.unsubscribe();
    }
  } catch {
    // Silently ignore errors during unsubscribe
  }
}

export async function ensurePushSubscription(lang: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  if (Notification.permission !== 'granted') return;
  const optIn = loadOptIn();
  if (!optIn?.enabled) return;

  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey?: string }>('/notifications/vapid-public-key');
  if (!publicKey) return;

  let sub = await reg.pushManager.getSubscription();

  const currentKey = sub?.options.applicationServerKey
    ? uint8ToUrlBase64(new Uint8Array(sub.options.applicationServerKey))
    : optIn.vapidPublicKey;
  const keyMismatch = sub != null && currentKey !== publicKey;

  if (keyMismatch || optIn.pendingResubscribe) {
    saveOptIn({ ...optIn, pendingResubscribe: true });
    if (sub) await sub.unsubscribe().catch(() => {});
    sub = null;
  }

  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
    });
  }

  await postSubscription(sub, lang);
  saveOptIn({ enabled: true, vapidPublicKey: publicKey });
}

export async function syncPushLanguage(lang: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    await postSubscription(subscription, lang === 'ja' ? 'ja' : 'en');
  } catch (err) {
    console.warn('[Push] syncPushLanguage failed:', err);
  }
}
