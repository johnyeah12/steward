/* Steward service worker — caches the app shell so the app opens
   instantly and works with no signal. Data never passes through here:
   GitHub API calls are left entirely alone. */

// Bumped automatically by deploy.sh — a stale value here is why an installed
// phone keeps serving the previous build.
const VERSION = 'steward-20260816123214';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './ocr.js',
  './statement.js',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
// vendor/* (the ~6MB Tesseract reader) is deliberately NOT precached — it is
// fetched on the first scan and then cached by the runtime handler below,
// so a fresh install stays small and fast.

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never touch the sync layer — it must always hit the network live.
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate: instant open, quietly picks up new versions.
  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => hit);
      return hit || net;
    })
  );
});
