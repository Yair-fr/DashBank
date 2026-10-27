/* DashBank service worker.
 * - Static shell: cache-first with background refresh (versioned cache name).
 * - /api/* GET: network-first, falling back to the last cached response, which is
 *   marked with an `X-DashBank-Offline: 1` header so the page can show an offline pill.
 * All URLs are relative to the SW scope so the app works behind a reverse proxy. */
const VERSION = 'v5';
const SHELL_CACHE = `dashbank-shell-${VERSION}`;
const API_CACHE = 'dashbank-api';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'i18n.js', 'locales/he.json', 'locales/en.json',
  'vendor/chart.umd.js', 'manifest.webmanifest',
  'legal/privacy.html', 'legal/terms.html', 'legal/accessibility.html', 'legal/legal.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dashbank-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set('X-DashBank-Offline', '1');
    return new Response(await cached.blob(), { status: cached.status, statusText: cached.statusText, headers });
  }
}

// Cache-first; on a hit the cache is also refreshed in the background so the next
// launch picks up new shell files without waiting for a VERSION bump.
async function cacheFirst(event) {
  const { request } = event;
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  const refresh = fetch(request).then((res) => {
    if (res.ok && res.type === 'basic') cache.put(request, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(refresh.catch(() => {}));
    return hit;
  }
  try {
    return await refresh;
  } catch (err) {
    if (request.mode === 'navigate') {
      const shell = await cache.match('./');
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  const rel = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : url.pathname;
  if (rel === 'api/transactions.csv') return; // downloads go straight to the network, never cached
  if (rel.startsWith('api/')) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(cacheFirst(event));
  }
});
