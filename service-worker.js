const CACHE_NAME = 'nakowa-v1';
const ASSETS = [
    '/ABAYA-S-WEBSITE/',
    '/ABAYA-S-WEBSITE/index.html',
    '/ABAYA-S-WEBSITE/style.css',
    '/ABAYA-S-WEBSITE/script.js',
    '/ABAYA-S-WEBSITE/manifest.json',
    '/ABAYA-S-WEBSITE/favicon.ico',
    '/ABAYA-S-WEBSITE/favicon.svg',
    '/ABAYA-S-WEBSITE/favicon-96x96.png',
    '/ABAYA-S-WEBSITE/apple-touch-icon.png',
    '/ABAYA-S-WEBSITE/web-app-manifest-192x192.png',
    '/ABAYA-S-WEBSITE/web-app-manifest-512x512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
            .catch(err => console.warn('Cache install failed:', err))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(names => Promise.all(
            names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (url.hostname.includes('script.google.com')) {
        event.respondWith(
            fetch(event.request).catch(() => new Response(
                JSON.stringify({ success: false, error: 'offline' }),
                { headers: { 'Content-Type': 'application/json' } }
            ))
        );
        return;
    }
    if (url.hostname.includes('cloudinary.com') || url.hostname.includes('supabase.co')) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                return cached || fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                });
            })
        );
        return;
    }
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request).then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            });
        })
    );
});