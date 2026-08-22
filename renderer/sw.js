/* ============================================================
   GemAir — service worker (PWA shell)
   Makes the hosted web build installable and usable from anywhere,
   including flaky mobile connections.

   Strategy
     • navigation  → network-first, cached index.html as offline fallback
     • static GET  → stale-while-revalidate (instant, refreshes in background)
     • /api/*      → network-ONLY. AI replies and live data are never cached;
                     offline calls get a graceful JSON so the UI can degrade
                     to the offline brain instead of throwing.
   Bump CACHE_VERSION whenever shipped assets change.
   ============================================================ */
'use strict';

const CACHE_VERSION = 'gemair-shell-v2.5.0';
const SHELL = [
  'index.html',
  'style.css',
  'reduced-motion.css',
  'app.js',
  'store.js',
  'avatar.js',
  'themes.js',
  'i18n.js',
  'tts-engine.js',
  'edge-tts.js',
  'ai-client.js',
  'favicon.svg',
  'manifest.webmanifest',
  'assets/gemair-logo.png',
  'assets/gemair-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll fails the whole install if ONE asset 404s — precache resiliently.
    await Promise.all(SHELL.map(async (asset) => {
      try { await cache.add(new Request(asset, { cache: 'reload' })); } catch { /* optional asset */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin traffic

  // API: network-only, honest offline payload (never a stale AI answer).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return new Response(JSON.stringify({ ok: false, error: 'offline', free: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
        });
      }
    })());
    return;
  }

  // Navigations: network-first with cached app shell fallback.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('index.html')) || Response.error();
      }
    })());
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
