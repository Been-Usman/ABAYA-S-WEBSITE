/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Service Worker (v1)
   Caches the app shell so the site works offline.
   Never caches API calls (Apps Script, Supabase, Cloudinary).
   ============================================================ */

const CACHE_NAME = 'nakowa-v1';

const CACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './queue.js',
  './manifest.json',
  './images/logo.png',
  './images/About.jpg',
  './favicon.ico',
  './favicon.svg',
  './favicon-96x96.png'
];

// ---------- INSTALL ----------
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(
        CACHE_URLS.map(function (url) {
          return cache.add(url).catch(function (err) {
            console.warn('[SW] Failed to cache:', url, err);
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
             .map(function (n) { return caches.delete(n); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ---------- FETCH ----------
self.addEventListener('fetch', function (event) {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  if (
    url.hostname.indexOf('script.google.com') !== -1 ||
    url.hostname.indexOf('supabase.co') !== -1 ||
    url.hostname.indexOf('cloudinary.com') !== -1
  ) {
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(function (res) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(function (c) { c.put('./index.html', copy); });
          return res;
        })
        .catch(function () {
          return caches.match('./index.html');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then(function (c) { c.put(req, copy); });
        return res;
      });
    })
  );
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});