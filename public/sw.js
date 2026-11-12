/**
 * PAKETÜS — Progressive Web App (PWA) Service Worker
 * Cache Version: paketus-v20261112
 * 
 * Rules:
 * 1. ASLA /api/* ve /health isteklerini önbelleğe alma (canlı SSE, REST ve sağlık verileri bypass edilir).
 * 2. Statik varlıklarda Ağ-Öncelikli (Network-First) ve Önbellek Yedekli (Cache Fallback) strateji uygulanır.
 * 3. Eski önbellek sürümleri anında temizlenir.
 */

const CACHE_NAME = 'paketus-v20261112';

const STATIC_PRECACHE = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/favicon.svg',
  '/brand/logo.svg',
  '/brand/icon-192.svg',
  '/brand/icon-512.svg'
];

// 1. Kurulum (Install)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Pre-cache without failing if any single asset is temporarily unavailable
        return Promise.allSettled(
          STATIC_PRECACHE.map((url) =>
            fetch(url, { cache: 'no-cache' })
              .then((res) => {
                if (res.ok) return cache.put(url, res);
              })
              .catch(() => {
                // Sessiz geç: ağ yoksa kurulum engellenmez
              })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

// 2. Etkinleştirme (Activate) & Eski Sürüm Temizliği
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// 3. İstek Yönetimi (Fetch)
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Yalnızca HTTP(S) GET istekleri önbellek mantığına tabi tutulur
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);

  // KESİNLİKLE ÖNBELLEĞE ALINMAYACAK İSTEKLER:
  // - /api/* (tüm REST uç noktaları, SSE canlı yayınları, Caller ID, vb.)
  // - /health (canlılık kontrolü)
  // - EventStream / SSE istekleri
  const isApiRequest = url.pathname.startsWith('/api/');
  const isHealthRequest = url.pathname === '/health' || url.pathname.startsWith('/health');
  const isEventStream = request.headers.get('Accept') && request.headers.get('Accept').includes('text/event-stream');

  if (isApiRequest || isHealthRequest || isEventStream) {
    // Doğrudan canlı ağa ilet, önbelleğe ASLA dokunma
    return;
  }

  // Statik Varlıklar: Ağ-Öncelikli (Network-First) Stratejisi
  // Yeni sürümleri hemen alır; ağ kesilirse önbellekten sunar
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Çevrimdışı / Ağ Hatası Durumu -> Önbellekten yanıt ver
        return caches.match(request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // Navigasyon (sayfa) isteği ise anasayfayı dene
          if (request.mode === 'navigate') {
            return caches.match('/index.html') || caches.match('/');
          }
          return new Response('Ağ bağlantısı yok ve kaynak önbellekte bulunamadı.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
      })
  );
});
