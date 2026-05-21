/**
 * Service Worker for HealthLog PWA.
 * Handles Web Push notifications and offline caching.
 */

// v1.4.38.4 — `CACHE_VERSION` now tracks the app release tag.
// Bumped on every release so the `activate` step evicts every
// pre-release cache entry. Without this the precached root HTML and
// the cached `/_next/static/*` chunks survived across deploys,
// stale-shell-served the old chunk graph, and the running app then
// hit `ChunkLoadError` on the first lazy navigation. Pair with the
// `<VersionPoller>` client component (mounted in `<Providers>`) that
// polls `/api/version`, compares against `NEXT_PUBLIC_APP_VERSION`,
// and triggers an SW-unregister + cache-wipe + hard reload when the
// server moves ahead of the running shell.
//
// v1.4.43 QoL (L3) — read the active version from `self.__APP_VERSION__`,
// which the build step writes to `/public/sw-version.js` (loaded
// synchronously below via `importScripts`). Pre-fix the literal was
// hand-bumped per release and quietly drifted four releases stale, so
// every deploy between v1.4.38.4 → v1.4.42 served the previous shell's
// cache instead of evicting it on activate. The fallback literal stays
// in case the import is missing (legacy SW versions, dev mode without
// the build step), but the source of truth is now the generated file.
try {
  importScripts("/sw-version.js");
} catch {
  // Fall through to the literal fallback below.
}
const CACHE_VERSION =
  (typeof self !== "undefined" && self.__APP_VERSION__) || "v1.4.43";
const STATIC_CACHE = `healthlog-static-${CACHE_VERSION}`;
const PAGE_CACHE = `healthlog-pages-${CACHE_VERSION}`;
const MAX_STATIC_ENTRIES = 150;
const MAX_PAGE_ENTRIES = 30;

// App shell files to precache on install
const PRECACHE_URLS = ["/", "/logo-192.png", "/logo-512.png", "/favicon.svg"];

// ── Install: precache app shell ──────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

// ── Activate: clean up old caches ────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== PAGE_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ── Fetch: strategy per resource type ────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // API calls — network only (never serve stale data)
  if (url.pathname.startsWith("/api/")) return;

  // Next.js static assets — cache-first (immutable hashed filenames)
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Static files (fonts, icons, images) — cache-first with long TTL
  if (/\.(png|svg|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // HTML pages — network-first with cache fallback
  if (request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(networkFirst(request, PAGE_CACHE));
    return;
  }
});

/**
 * Cache-first: serve from cache, fall back to network and cache the response.
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
    trimCache(cacheName, MAX_STATIC_ENTRIES);
  }
  return response;
}

/**
 * Network-first: try network, fall back to cache.
 */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
      trimCache(cacheName, MAX_PAGE_ENTRIES);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    // Offline fallback. F-7 (mobile security audit, 2026-05-16): the
    // previous fallback rendered hard-coded German body copy, which is
    // wrong for any en/* user reaching it offline. The replacement is
    // language-neutral — wordmark + the universally understood
    // "Offline" token + a generic retry hint expressed as an icon
    // (the round-trip arrow), so the page does the right thing in any
    // locale without shipping a translation bundle into the worker.
    return new Response(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HealthLog — Offline</title><style>body{font-family:system-ui,sans-serif;background:#282a36;color:#f8f8f2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center;padding:2rem}h1{color:#bd93f9;margin:0 0 .5rem;font-size:2rem;letter-spacing:.05em}p{color:#6272a4;margin:.25rem 0;font-size:.9rem}svg{width:48px;height:48px;color:#6272a4;margin-bottom:1rem}</style></head><body><div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg><h1>HealthLog</h1><p>Offline</p></div></body></html>',
      {
        status: 503,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }
}

/**
 * Trim cache to maxEntries by removing oldest entries.
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  let keys = await cache.keys();
  while (keys.length > maxEntries) {
    await cache.delete(keys[0]);
    keys = await cache.keys();
  }
}

// ── Push Notifications ───────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "HealthLog", body: event.data.text() };
  }

  const {
    title = "HealthLog",
    body = "",
    tag = "default",
    url = "/",
  } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      icon: "/logo-192.png",
      badge: "/logo-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // F-7 (mobile security audit, 2026-05-16): validate the destination
  // resolves to the same origin before navigating any client. Push
  // payloads are VAPID-signed by our own server, but a server-side bug
  // (or compromised admin issuing pushes) could ship an off-origin URL
  // into `data.url` and use the focused PWA as a redirect-driven phish.
  // Reject anything that doesn't match our origin and fall back to "/".
  const rawUrl = event.notification.data?.url || "/";
  let safeUrl = "/";
  try {
    const resolved = new URL(rawUrl, self.location.origin);
    if (resolved.origin === self.location.origin) {
      safeUrl = resolved.pathname + resolved.search + resolved.hash;
    }
  } catch {
    safeUrl = "/";
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.navigate(safeUrl);
            return client.focus();
          }
        }
        return self.clients.openWindow(safeUrl);
      }),
  );
});
