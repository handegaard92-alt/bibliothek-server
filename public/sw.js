// Service Worker for Bibliothek PWA
// Strategi:
//  - HTML/JSON: nettverk først, fall back til cache (slik at ny versjon alltid prøves)
//  - Statiske ikoner / manifest: cache-first
//  - Bok-cover (R2 / openlibrary / google books): cache-first med 7 dagers utløp
//  - API/auth: alltid nettverk (ingen cache)

const VERSION = 'v1';
const STATIC_CACHE = 'bibliothek-static-' + VERSION;
const COVER_CACHE  = 'bibliothek-covers-' + VERSION;
const HTML_CACHE   = 'bibliothek-html-' + VERSION;

const STATIC_ASSETS = [
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isApiRequest(url) {
  // Disse skal aldri caches
  return /\/(library|files|auth|series-proxy|ai-chat|backups|guest-link|guest-links|send-to-kindle)\b/.test(url.pathname);
}

function isCoverRequest(url) {
  if (url.pathname.startsWith('/files/download/')) return true;
  if (url.hostname.includes('covers.openlibrary.org')) return true;
  if (url.hostname.includes('books.google.com')) return true;
  if (url.hostname.includes('googleusercontent.com')) return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // API: bare nettverk
  if (isApiRequest(url)) return;

  // Bok-cover: cache-first med 7 dagers utløp
  if (isCoverRequest(url)) {
    event.respondWith(coverHandler(req));
    return;
  }

  // HTML (root + .html): network-first, fallback til cache
  if (url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirst(req, HTML_CACHE));
    return;
  }

  // Statiske ikoner og manifest: cache-first
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.json') {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }
});

async function networkFirst(req, cacheName) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (_) {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw _;
  }
}

async function cacheFirst(req, cacheName) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    const cache = await caches.open(cacheName);
    cache.put(req, fresh.clone());
  }
  return fresh;
}

async function coverHandler(req) {
  const cache = await caches.open(COVER_CACHE);
  const cached = await cache.match(req);
  const sevenDays = 7 * 24 * 3600 * 1000;
  if (cached) {
    // Sjekk om utgått basert på sw-cached-at-header
    const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0');
    if (cachedAt && Date.now() - cachedAt < sevenDays) return cached;
  }
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const headers = new Headers(fresh.headers);
      headers.set('sw-cached-at', String(Date.now()));
      const body = await fresh.clone().blob();
      const wrapped = new Response(body, { status: fresh.status, statusText: fresh.statusText, headers });
      cache.put(req, wrapped);
    }
    return fresh;
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}
