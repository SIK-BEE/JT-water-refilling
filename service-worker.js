/* JT Water Refilling installable app shell. Runtime fetch uses network-first to avoid stale deployed code. */
const CACHE_NAME = 'jt-water-refilling-shell-v10-transparent-logo-icons';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/main.css',
  './css/auth.css',
  './css/dashboard.css',
  './css/overhaul.css',
  './js/auth.js',
  './js/admin.js',
  './js/api.js',
  './js/customer.js',
  './js/driver.js',
  './js/staff.js',
  './js/firebase-init.js',
  './js/team-profile.js',
  './assets/JT_LOGO.png',
  './assets/SIKBEE_LOGO.png',
  './assets/app-icon-192.png',
  './assets/app-icon-512.png',
  './sounds/error.wav',
  './sounds/success.wav'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try { await cache.addAll(APP_SHELL); } catch (error) { console.warn('Some app-shell files could not be cached:', error); }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('jt-water-refilling-shell-') && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Only cache this app's own static shell. Firebase and other API traffic must stay network-only.
  if (url.origin !== self.location.origin) return;
  if (['/api/', '/__/auth/', '/__/firebase/', '/firestore/', '/identitytoolkit/', '/securetoken/'].some(part => url.pathname.toLowerCase().includes(part))) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && (fresh.type === 'basic' || fresh.type === 'default')) cache.put(request, fresh.clone()).catch(() => {});
      return fresh;
    } catch (error) {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
