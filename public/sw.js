/**
 * Service Worker for HealthLog PWA.
 * Handles Web Push notifications and offline caching.
 */

const CACHE_VERSION = "v1";
const STATIC_CACHE = `healthlog-static-${CACHE_VERSION}`;
const PAGE_CACHE = `healthlog-pages-${CACHE_VERSION}`;

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
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response("Offline", { status: 503 });
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

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && "focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
