// Keeps the app working offline. The app never talks to any server except the one it was installed from.
const VERSION = 'v10';
const SHELL = `shell-${VERSION}`;
const READER = 'reader-v1';

const SHELL_FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
  'src/app.js',
  'src/store.js',
  'src/crypto.js',
  'src/ocr.js',
  'src/parse.js',
  'src/categorize.js',
  'src/model.js',
  'src/format.js',
  'src/charts.js',
  'src/icons.js',
  'src/logos.js',
  'src/biometric.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== READER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // The text reader is large and never changes for a version: cache it the first time it's used.
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(READER).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  // App files: network first so updates arrive, cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
