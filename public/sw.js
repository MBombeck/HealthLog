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
// The `|| "..."` fallback literal is the value used only when the
// `importScripts('/sw-version.js')` above is absent (dev with no `prebuild`
// step, or a 404 on the generated file). `scripts/generate-sw-version.mjs`
// rewrites it to the current `package.json` version on every prebuild — the
// marker below is the rewrite anchor — so in any shipped image the literal
// matches the active release and can never drift stale the way it did across
// v1.4.38.4 → v1.4.42. Do not hand-edit; bump `package.json` and rebuild.
const CACHE_VERSION =
  (typeof self !== "undefined" && self.__APP_VERSION__) ||
  /* @sw-version-fallback */ "v1.31.5";
const STATIC_CACHE = `healthlog-static-${CACHE_VERSION}`;
const PAGE_CACHE = `healthlog-pages-${CACHE_VERSION}`;
// v1.18.6 — read-only data cache for a curated allowlist of safe GET `/api/*`
// reads. Network-first: online callers always get the fresh server response
// (and the cache is refreshed behind it), so a read-after-write never serves a
// stale pre-mutation list. Offline (the network fetch throws) the LAST cached
// dashboard/series is served instead of empty skeletons forever.
//
// v1.18.6.x — reverted from stale-while-revalidate, which served the cached
// pre-mutation copy first and only revalidated in the background, so a list
// read straight after a create/update showed the old (or empty) data until the
// next paint. Network-first restores read-after-write freshness while keeping
// the offline fallback.
const DATA_CACHE = `healthlog-data-${CACHE_VERSION}`;
const MAX_STATIC_ENTRIES = 150;
const MAX_PAGE_ENTRIES = 30;
const MAX_DATA_ENTRIES = 60;

// Safe-GET read allowlist. ONLY idempotent reads that render the core views
// and carry NO secret-shaped body. Auth, mutations and token endpoints are
// never listed — and `isCacheableApiResponse` is a second, body-level guard
// (mirrors the idempotency cache's `hlk_`/`hlr_`/`sk-` refusal) so a future
// endpoint that slipped onto the list can still never persist a secret.
// Matched by exact path or `<path>/` / `<path>?` prefix.
// v1.18.6 — AI/clinical narrative surfaces (`/api/insights`, `/api/analytics`)
// are deliberately NOT cached: `/api/insights` prefix-matched the Coach chat
// endpoint into the disk cache, and neither belongs on a self-hosted health
// PWA's durable storage. Only the dashboard snapshot, the widget layout, the
// measurement reads (incl. the batched daily series), the medication reads,
// and the version probe are eligible.
const API_READ_ALLOWLIST = [
  "/api/dashboard/snapshot",
  "/api/dashboard/widgets",
  "/api/measurements",
  "/api/medications",
  "/api/version",
];

// Defence in depth: even an allowlisted path is refused if its pathname looks
// like an auth/token/secret surface.
const API_DENY_RE = /\/(auth|tokens?|sessions?|login|password|webauthn)(\/|$|\?)/i;

function isAllowlistedApiRead(pathname) {
  if (API_DENY_RE.test(pathname)) return false;
  return API_READ_ALLOWLIST.some(
    (p) =>
      pathname === p ||
      pathname.startsWith(p + "/") ||
      pathname.startsWith(p + "?"),
  );
}

// Body-level secret refusal: never persist a body carrying a token/secret-
// shaped pattern even if the path was allowlisted by mistake.
const SECRET_BODY_RE = /(hlk_|hlr_|sk-)[A-Za-z0-9_-]/;

function isCacheableApiResponse(response, bodyText) {
  if (!response || !response.ok) return false;
  const cacheControl = response.headers.get("Cache-Control") || "";
  if (/no-store/i.test(cacheControl)) return false;
  if (typeof bodyText === "string" && SECRET_BODY_RE.test(bodyText)) {
    return false;
  }
  return true;
}

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
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (k) =>
                  k !== STATIC_CACHE && k !== PAGE_CACHE && k !== DATA_CACHE,
              )
              .map((k) => caches.delete(k)),
          ),
        ),
      // Navigation preload lets the browser start the navigation request
      // in parallel with service-worker startup; `networkFirst` consumes
      // it via `event.preloadResponse`, shaving SW boot latency off every
      // page navigation. Guarded — older engines lack the API.
      self.registration.navigationPreload
        ? self.registration.navigationPreload.enable()
        : Promise.resolve(),
    ]).then(() => self.clients.claim()),
  );
});

// ── Fetch: strategy per resource type ────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // API calls. Allowlisted safe GET reads use network-first so the installed
  // PWA always renders fresh server data online (and falls back to the last
  // cached copy only when the network fails); everything else (auth,
  // mutations, anything not on the list) stays network-only.
  if (url.pathname.startsWith("/api/")) {
    if (isAllowlistedApiRead(url.pathname)) {
      event.respondWith(networkFirstApi(request));
    }
    return;
  }

  // Next.js static assets — cache-first (immutable hashed filenames)
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Locale-catalog boot script — cache-first. The URL is versioned
  // (`/i18n/<locale>?v=<build>`) and served immutable, so cache-first is
  // correct and keeps the catalog available on an offline relaunch (the
  // cached shell HTML references the same versioned URL it was rendered
  // with). Carries no user data — same public strings as the repository's
  // messages/*.json.
  if (url.pathname.startsWith("/i18n/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Static files (fonts, icons, images) — cache-first with long TTL
  if (/\.(png|svg|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // HTML pages — network-first with cache fallback. The whole event is
  // passed so `networkFirst` can consume the navigation-preload response.
  if (request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(networkFirst(event, PAGE_CACHE));
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
 * Network-first for allowlisted safe GET `/api/*` reads.
 *
 * Always tries the network first so an online caller gets the fresh server
 * response — critical for read-after-write: a list fetched straight after a
 * create/update must reflect the mutation, not a stale pre-mutation copy. On a
 * cacheable response the data cache is refreshed behind it. Only when the
 * network fails (offline) is the last cached copy served; with neither, a JSON
 * 503 lets the client's TanStack Query cache / IndexedDB persister supply data.
 *
 * Caching is gated twice: `isAllowlistedApiRead` already filtered the path,
 * and `isCacheableApiResponse` inspects the actual body so a `no-store` or
 * secret-shaped (`hlk_`/`hlr_`/`sk-`) response is never persisted — the same
 * refusal discipline the idempotency cache uses.
 */
async function networkFirstApi(request) {
  const cache = await caches.open(DATA_CACHE);

  try {
    const response = await fetch(request);
    // Read the body once to body-screen it, then reconstruct a fresh Response
    // so both the cache.put and the return value have an unconsumed body.
    const bodyText = await response
      .clone()
      .text()
      .catch(() => undefined);
    if (isCacheableApiResponse(response, bodyText)) {
      const toStore = new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      await cache.put(request, toStore);
      trimCache(DATA_CACHE, MAX_DATA_ENTRIES);
    }
    return response;
  } catch {
    // Network failed (offline) — serve the last cached copy if we have one.
    const cached = await cache.match(request);
    if (cached) return cached;

    return new Response(
      JSON.stringify({ data: null, error: "offline", meta: { offline: true } }),
      {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }
}

/**
 * Privacy gate for the navigation page cache. Most app routes are
 * client-fetch-only shells with no server-rendered PII (health JSON loads
 * over `/api/*`, which is network-only here), so caching their HTML is
 * safe. Two carve-outs:
 *
 *   1. A `Cache-Control: no-store` response opts itself out — the
 *      principled, future-proof rule for any current/future server RSC
 *      that renders user data and sets the header.
 *   2. `/c/*` (the clinician-share view) renders health values + wellness
 *      scores straight into the HTML and emits `no-store`; the explicit
 *      path skip is belt-and-braces so a revoked share can never linger in
 *      CacheStorage and render back offline.
 */
function isCacheableNavigation(request, response) {
  const cacheControl = response.headers.get("Cache-Control") || "";
  if (/no-store/i.test(cacheControl)) return false;
  try {
    const { pathname } = new URL(request.url);
    if (pathname === "/c" || pathname.startsWith("/c/")) return false;
  } catch {
    // Unparseable URL — fall through; the no-store check already ran.
  }
  return true;
}

/**
 * Network-first: try network (preferring the navigation-preload response
 * when the browser already started it), fall back to cache.
 *
 * The offline fallback only serves a shell cached under the CURRENT
 * `CACHE_VERSION` cache names. The previous global `caches.match()` could
 * resolve from a stale pre-update cache in the activation gap and serve a
 * shell whose `/_next/static/*` chunk graph no longer exists
 * (`ChunkLoadError` on the first lazy navigation).
 */
async function networkFirst(event, cacheName) {
  const { request } = event;
  try {
    const response =
      (event.preloadResponse ? await event.preloadResponse : null) ||
      (await fetch(request));
    if (response.ok && isCacheableNavigation(request, response)) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
      trimCache(cacheName, MAX_PAGE_ENTRIES);
    }
    return response;
  } catch {
    // Version-scoped fallback: the page cache first, then the precached
    // app shell — both names embed CACHE_VERSION, so a stale shell from a
    // previous release can never be served here.
    const pageCache = await caches.open(cacheName);
    const cachedPage = await pageCache.match(request);
    if (cachedPage) return cachedPage;
    const staticCache = await caches.open(STATIC_CACHE);
    const precached = await staticCache.match(request);
    if (precached) return precached;

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
 * Trim cache to maxEntries by removing oldest entries. `keys()` returns
 * insertion order, so one read + a single pass over the excess prefix
 * replaces the previous re-fetch-keys-per-deletion loop (O(n²) reads).
 */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

// ── App badge helper (PWA Badging API) ───────────────────────────────────────
// v1.18.4 — reflect the server-authoritative outstanding-dose count on the
// installed PWA icon. Feature-detected + best-effort: unsupported engines
// (most desktop Firefox, older Safari) silently no-op. A count of 0 clears the
// badge; a positive count sets it. `undefined`/non-number leaves it untouched.
function applyAppBadge(count) {
  if (typeof count !== "number" || !isFinite(count)) return;
  try {
    if (count > 0) {
      if (typeof self.navigator?.setAppBadge === "function") {
        self.navigator.setAppBadge(count);
      }
    } else if (typeof self.navigator?.clearAppBadge === "function") {
      self.navigator.clearAppBadge();
    }
  } catch {
    // Badging API can reject (permission / unsupported) — never let it
    // break the push handler.
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

  // v1.18.4 — `type:"clear"` is the PWA equivalent of ending an iOS Live
  // Activity: the server sends it when a dose is logged so the still-pending
  // dose-due reminder for that slot is closed here (matched on its stable
  // `tag`), and the app badge re-reflects the outstanding-dose count. No new
  // notification is shown.
  if (payload && payload.type === "clear") {
    event.waitUntil(
      (async () => {
        const tagToClear = payload.tag;
        if (tagToClear) {
          const matches = await self.registration.getNotifications({
            tag: tagToClear,
          });
          for (const n of matches) n.close();
        }
        applyAppBadge(payload.badge);
      })(),
    );
    return;
  }

  const {
    title = "HealthLog",
    body = "",
    tag = "default",
    url = "/",
    badge,
    requireInteraction = false,
  } = payload;

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body,
        tag,
        // `renotify` lets a re-fired reminder for the same `tag` re-alert the
        // user instead of silently replacing the existing notification.
        renotify: true,
        // v1.18.4 — urgent events (the web-push sender sets this) keep the
        // notification on screen until the user acts, where the browser
        // honours it.
        requireInteraction: requireInteraction === true,
        icon: "/logo-192.png",
        badge: "/logo-192.png",
        data: { url },
      }),
      Promise.resolve(applyAppBadge(badge)),
    ]),
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
