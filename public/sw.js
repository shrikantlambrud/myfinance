// MyFinance admin app service worker.
// Only caches the static app shell (HTML/JS/CSS/icons) so the app installs and opens instantly.
// It NEVER caches /api/ responses - loan and cash data must always come straight from the server.
const CACHE = 'myfinance-shell-v2';
const SHELL = [
  '/', '/manifest.json',
  '/assets/styles.css', '/assets/api.js', '/assets/ui.js', '/assets/state.js', '/assets/app.js',
  '/assets/views/today.js', '/assets/views/loans.js', '/assets/views/people.js', '/assets/views/money.js',
  '/assets/views/admin.js', '/assets/views/payments.js', '/assets/views/analytics.js', '/assets/charts.js',
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
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // let everything else pass through untouched
  if (url.pathname.startsWith('/api/')) return; // never intercept API calls - always live data

  // Stale-while-revalidate for the app shell: instant load from cache, refreshed quietly
  // in the background so the next open picks up whatever was last deployed.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
      return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
    }),
  );
});
