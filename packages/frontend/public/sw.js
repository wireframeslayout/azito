const CACHE_NAME = 'azito-v3'; // v3: アイコン一新（icon.svg差し替え・PNG追加）に伴うキャッシュ無効化
const PRECACHE_URLS = ['/', '/index.html'];

// Install: precache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API/WS, cache-first for static assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET and WebSocket upgrade requests
  if (event.request.method !== 'GET') return;
  // Skip chrome-extension and other non-http(s) schemes
  if (!url.protocol.startsWith('http')) return;

  // Skip Vite dev-server modules entirely (dev mode only paths).
  // Caching these causes duplicate React copies after re-optimization.
  if (
    url.pathname.startsWith('/node_modules/') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/@')
  ) {
    return;
  }

  // Network-first for API calls and WebSocket
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Network-first for navigation (SPA: any route → /index.html fallback)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request)
          .then((cached) => cached || caches.match('/index.html'))
          .then((cached) => cached || caches.match('/'))
      )
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Only cache successful same-origin responses
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  console.log('[SW] Push received:', event.data?.text());
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { console.error('[SW] Parse error:', e); }
  const title = data.title || 'AZITO';
  const options = {
    body: data.body || 'AZITO',
    data: data.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Agent completed/blocked pushes (see buildServer.ts) attach
  // { url: '/workspace', serverName, target[, taskId] } as `data`. No
  // per-server/target deep link exists yet, so we just navigate to the
  // plain `/workspace` url below — the existing url-based logic already
  // covers this case without any special-casing.
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      const baseUrl = url.split('?')[0];
      for (const client of windowClients) {
        const clientBase = client.url.split('?')[0];
        if (clientBase.endsWith(baseUrl) && 'focus' in client) {
          if (client.url !== new URL(url, client.url).href) {
            client.navigate(url);
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
