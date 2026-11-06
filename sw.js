// Offline cache: app shell first, network for live data (orbit + city search).
const CACHE = 'iss-tracker-v1';
const SHELL = [
  './', 'index.html', 'sky.html', 'style.css', 'orbit.js', 'globe.js', 'sky.js',
  'vendor/three.module.min.js', 'vendor/OrbitControls.js', 'vendor/satellite.min.js',
  'img/earth-day.jpg', 'img/earth-night.jpg', 'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // live APIs and fonts go straight to the network
  // network first so updates land, cache as the offline fallback
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
