/**
 * HealthLog service worker: Web Push, a page cache for public pages, and a
 * static cache for catalogs, icons, fonts and images. API answers and app
 * chunks are never stored here.
 */

// Cache names carry the release, so `activate` drops every older cache. The
// build writes the release to `/sw-version.js`; the literal below is the
// fallback when that file is missing (dev without `prebuild`, a 404), and
// `scripts/generate-sw-version.mjs` rewrites it at the marker on every
// build. Do not edit it by hand.
try {
  importScripts("/sw-version.js");
} catch {
  // Fall through to the fallback literal.
}
const CACHE_VERSION =
  (typeof self !== "undefined" && self.__APP_VERSION__) ||
  /* @sw-version-fallback */ "v1.47.4";
const STATIC_CACHE = `healthlog-static-${CACHE_VERSION}`;
const PAGE_CACHE = `healthlog-pages-${CACHE_VERSION}`;
// Every HealthLog cache, current and legacy, and nothing another app on the
// origin owns. `data` stays in the pattern so caches from releases that still
// kept API reads are deleted on activate. Same pattern as
// `HEALTHLOG_CACHE_NAME_RE` in `src/lib/pwa/sw-cache-policy.ts`.
const HEALTHLOG_CACHE_NAME_RE = /^healthlog-(?:static|pages|data)-/;
const CURRENT_HEALTHLOG_CACHES = new Set([STATIC_CACHE, PAGE_CACHE]);
// Set by `src/proxy.ts` on every HealthLog page; same name as there.
const HEALTHLOG_PAGE_MARKER_HEADER = "X-HealthLog-Page";
// While set, the fetch handler declines every request. Set when a page looks
// like another app, cleared unless the probe confirms another app.
let foreignOrigin = false;
// One confirmation at a time, shared by a burst of navigations.
let foreignOriginCheck = null;
const MAX_STATIC_ENTRIES = 150;
const MAX_PAGE_ENTRIES = 30;

// Never `/`: installed while signed in, it would store the dashboard HTML.
const PRECACHE_URLS = ["/logo-192.png", "/logo-512.png", "/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

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
                  HEALTHLOG_CACHE_NAME_RE.test(k) &&
                  !CURRENT_HEALTHLOG_CACHES.has(k),
              )
              .map((k) => caches.delete(k)),
          ),
        ),
      // The browser starts the navigation while the worker boots;
      // `networkFirst` uses `event.preloadResponse`.
      self.registration.navigationPreload
        ? self.registration.navigationPreload.enable()
        : Promise.resolve(),
    ]).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (foreignOrigin) return;

  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // The OIDC login and callback are navigations the browser has already sent
  // as a preload. Declining here would make it send them a second time, and
  // the single-use code fails on the second. Answer with the preload (or one
  // fetch) and store nothing.
  if (url.pathname.startsWith("/api/auth/")) {
    event.respondWith(
      (async () => (await event.preloadResponse) || fetch(request))(),
    );
    return;
  }

  // Every other API request goes to the network untouched: no API answer is
  // kept on this device.
  if (url.pathname.startsWith("/api/")) return;

  // Locale catalog: the URL carries the catalogs' content hash, so a change
  // is a new URL. Public strings only.
  if (url.pathname.startsWith("/i18n/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (/\.(png|svg|jpg|jpeg|gif|webp|ico|woff2?|ttf|eot)$/i.test(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(networkFirst(event, PAGE_CACHE));
    return;
  }
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    await bestEffortCacheWrite(
      cacheName,
      request,
      response.clone(),
      MAX_STATIC_ENTRIES,
    );
  }
  return response;
}

/**
 * Which navigation responses may land in the page cache. Signed-in pages
 * never do: the proxy sends them `private, no-store` because some carry one
 * account's record in the HTML. Two paths are skipped by name as well: the
 * clinician share view `/c/*` (no-store too; a revoked share must never
 * render back offline) and `/onboarding/*`. What is left are the public
 * pages (sign-in, legal), so a navigation to an app page without a
 * connection gets the offline page, never somebody's cached record.
 */
function isCacheableNavigation(request, response) {
  const cacheControl = response.headers.get("Cache-Control") || "";
  if (/no-store/i.test(cacheControl)) return false;
  try {
    const { pathname } = new URL(request.url);
    if (pathname === "/c" || pathname.startsWith("/c/")) return false;
    // Public to the proxy, so not no-store, but rendered for a signed-in
    // account during its setup.
    if (pathname === "/onboarding" || pathname.startsWith("/onboarding/")) {
      return false;
    }
  } catch {
    // Unparseable URL — fall through; the no-store check already ran.
  }
  return true;
}

/**
 * Does this page come from another app on the same origin (a developer's
 * `localhost:3000`, say)? Only a successful page without the proxy's marker
 * counts: a redirect is opaque, and a 401 or 502 from a gateway in front of a
 * stopped HealthLog proves nothing. Still only a suspicion, because a proxy
 * with a header allowlist strips the marker; `confirmForeignOrigin` decides.
 */
function isForeignNavigationResponse(response) {
  if (!response || !response.ok) return false;
  return !response.headers.has(HEALTHLOG_PAGE_MARKER_HEADER);
}

/**
 * Is the origin positively not HealthLog? Asks the public `/api/version`,
 * whose body (`data.version` a string, `data.buildSha` present, possibly
 * null) survives any header rewriting. A 404, non-JSON or another shape is
 * foreign; a thrown fetch, a 5xx, a 401 or a redirect proves nothing.
 *
 * An auth gateway that answers an expired session with a 200 sign-in page
 * still reads as foreign, which is why `retireFromForeignOrigin` keeps a
 * worker that holds a push subscription. The gateway cookie is sent, so a
 * valid gateway session reaches HealthLog.
 */
async function confirmForeignOrigin() {
  let response;
  try {
    response = await fetch("/api/version", {
      cache: "no-store",
      redirect: "manual",
      credentials: "same-origin",
    });
  } catch {
    return false;
  }
  if (response.status === 404) return true;
  if (!response.ok) return false;
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return true;
  }
  const data = body && typeof body === "object" ? body.data : null;
  const isHealthlog =
    !!data &&
    typeof data === "object" &&
    typeof data.version === "string" &&
    "buildSha" in data;
  return !isHealthlog;
}

/** Confirm, then retire or resume. Shared by concurrent navigations. */
function checkForeignOrigin() {
  if (!foreignOriginCheck) {
    foreignOriginCheck = (async () => {
      let foreign = false;
      try {
        foreign = await confirmForeignOrigin();
      } catch {
        foreign = false;
      }
      if (foreign) {
        await retireFromForeignOrigin();
        return;
      }
      // HealthLog after all, or no answer: resume, and ask again next time.
      foreignOrigin = false;
      foreignOriginCheck = null;
    })();
  }
  return foreignOriginCheck;
}

/**
 * Whether this registration holds a Web Push subscription, which
 * unregistering would destroy without notice. When unsure, yes: a
 * pass-through worker costs nothing, lost reminders do.
 */
async function hasPushSubscription() {
  try {
    const pushManager = self.registration.pushManager;
    if (!pushManager || typeof pushManager.getSubscription !== "function") {
      return true;
    }
    return (await pushManager.getSubscription()) !== null;
  } catch {
    return true;
  }
}

/**
 * Leave an origin that no longer serves HealthLog: delete HealthLog's caches
 * (never another app's) and unregister. With a push subscription it stays
 * registered in pass-through instead (`foreignOrigin` stays set), and the
 * next worker start probes again. Each step is independent: a failed delete
 * must not keep the worker registered.
 */
async function retireFromForeignOrigin() {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => HEALTHLOG_CACHE_NAME_RE.test(k))
        .map((k) => caches.delete(k)),
    );
  } catch {
    // CacheStorage unavailable; unregistering matters more.
  }
  if (await hasPushSubscription()) return;
  try {
    await self.registration.unregister();
  } catch {
    // Nothing further to do from inside the worker.
  }
}

/**
 * Network-first for pages: the navigation-preload response when the browser
 * already started it, else a fetch. Without a connection, a page from this
 * release's page cache (only public pages are there), else the offline page.
 * The lookup is scoped to this release's cache name: a page from an older
 * release would reference chunks that no longer exist.
 */
async function networkFirst(event, cacheName) {
  const { request } = event;
  try {
    const response =
      (event.preloadResponse ? await event.preloadResponse : null) ||
      (await fetch(request));
    if (isForeignNavigationResponse(response)) {
      // Step aside at once; delete nothing until it is confirmed.
      foreignOrigin = true;
      event.waitUntil(checkForeignOrigin());
      return response;
    }
    if (response.ok && isCacheableNavigation(request, response)) {
      event.waitUntil(
        bestEffortCacheWrite(
          cacheName,
          request,
          response.clone(),
          MAX_PAGE_ENTRIES,
        ),
      );
    }
    return response;
  } catch {
    const cachedPage = await (await caches.open(cacheName)).match(request);
    if (cachedPage) return cachedPage;
    return new Response(OFFLINE_PAGE, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

// Language-neutral, because the worker ships no catalog: the wordmark, the
// word "Offline" and a 64 px retry link. It reloads itself when the
// connection returns, follows the device scheme and keeps clear of the notch.
const OFFLINE_PAGE =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>HealthLog — Offline</title><style>' +
  ":root{--bg:#282a36;--fg:#f8f8f2;--accent:#bd93f9;--muted:#a4a9c9;color-scheme:dark}" +
  "@media (prefers-color-scheme:light){:root{--bg:#f3f2f5;--fg:#1f2030;--accent:#6b46c1;--muted:#5b5e78;color-scheme:light}}" +
  "body{font-family:system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;margin:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);box-sizing:border-box}" +
  "main{text-align:center;padding:2rem}h1{color:var(--accent);margin:0 0 .5rem;font-size:2rem;letter-spacing:.05em}p{color:var(--muted);margin:.25rem 0 1.5rem;font-size:1rem}" +
  "a{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:9999px;color:var(--accent);border:2px solid currentColor}a:focus-visible{outline:3px solid var(--accent);outline-offset:3px}svg{width:28px;height:28px}" +
  '</style></head><body><main><h1>HealthLog</h1><p>Offline</p><a href="" aria-label="Reload" title="Reload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg></a></main>' +
  '<script>addEventListener("online",function(){location.reload()})</script></body></html>';

/**
 * Store a response, then trim. Failures (quota, eviction) are swallowed: a
 * cache write must never replace a response that already succeeded.
 */
async function bestEffortCacheWrite(
  cacheName,
  request,
  response,
  maxEntries,
) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    await trimCache(cacheName, maxEntries);
  } catch {
    // Optional.
  }
}

/** Drop the oldest entries past `maxEntries`; `keys()` is insertion order. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  const excess = keys.length - maxEntries;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

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
    requireInteraction = false,
  } = payload;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // A re-sent reminder with the same tag alerts again.
      renotify: true,
      // Set by the sender for urgent events, where the browser honours it.
      requireInteraction: requireInteraction === true,
      icon: "/logo-192.png",
      badge: "/logo-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // Only ever navigate within this origin: a server bug or a compromised
  // sender must not turn a tap into a redirect elsewhere.
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

  const target = new URL(safeUrl, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        const windows = clientList.filter(
          (c) => c.url.startsWith(self.location.origin + "/") && "focus" in c,
        );
        // A window already on the target only needs focus: navigating it
        // would reload the app and drop whatever is open there.
        const there = windows.find((c) => c.url === target);
        if (there) return there.focus();
        const client = windows[0];
        if (!client) return self.clients.openWindow(safeUrl);
        // Focus first, while the tap still counts as user activation.
        return client
          .focus()
          .then(() => client.navigate(safeUrl))
          .catch(() => self.clients.openWindow(safeUrl));
      }),
  );
});
