// Minimal service worker — this app has no meaningful offline mode (every real feature
// depends on Nominatim/OSRM or Firestore), so this exists only to (a) satisfy the browser's
// installability requirement for a PWA and (b) let the static app shell still load if opened
// with no connection. Everything else always goes to the network untouched.
const CACHE_NAME = 'trasee-curieri-shell-v2';
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './curier.html',
  './curier.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './manifest-curier.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first, not cache-first: a courier/dispatcher who has this installed and open for
// days must always get today's code the moment they reload, not whatever was cached on
// install. The cache only exists as a fallback for the rare case of opening with no
// connection at all — matches the "no meaningful offline mode" intent above. (An earlier
// cache-first version silently served yesterday's app.js/curier.js and only refreshed the
// cache for the NEXT load — a real bug, not just a delay.)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok){
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
