// My Loans (customer portal) service worker.
// Only caches the static app shell - loan balances, dues and payments always come live from /api/.
const CACHE = 'myloans-shell-v1';
const SHELL = [
  '/portal', '/portal/manifest.json', '/portal/portal.js', '/portal/portal.css',
  '/assets/styles.css', '/assets/api.js', '/assets/ui.js',
  '/assets/icons/icon-192.png', '/assets/icons/icon-512.png', '/assets/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never intercept API calls - always live data

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
    }),
  );
});
