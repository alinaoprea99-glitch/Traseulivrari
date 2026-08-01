// Minimal service worker — this app has no meaningful offline mode (every real feature
// depends on Nominatim/OSRM or Firestore), so this exists only to (a) satisfy the browser's
// installability requirement for a PWA and (b) let the static app shell still load if opened
// with no connection. Everything else always goes to the network untouched.
const CACHE_NAME = 'trasee-curieri-shell-v1';
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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request).then((response) => {
        if (response.ok){
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
