/**
 * v1.15.20 — service-worker cache behaviour, evaluated in a `vm` sandbox.
 *
 * `public/sw.js` is plain script (no module system), so the test boots it
 * inside a vm context with a fake CacheStorage and dispatches the captured
 * event listeners. Four behaviours are pinned:
 *
 *   1. cache write and trim failures never replace a successful network
 *      response for API, navigation, or static-asset requests;
 *   2. the offline HTML fallback only serves a shell cached under the
 *      CURRENT `CACHE_VERSION` cache names (a stale pre-update shell would
 *      reference a chunk graph that no longer exists);
 *   3. `activate` enables navigation preload and `networkFirst` consumes
 *      `event.preloadResponse` when the browser supplies it;
 *   4. `trimCache` reads the key list once and deletes the excess prefix
 *      in a single pass (the previous loop re-fetched all keys per delete).
 *
 * A HealthLog page response carries the `X-HealthLog-Page` marker the proxy
 * sets, so the navigation fixtures below build pages with `healthlogPage()`.
 * A successful page without it is another app on the same origin (#847),
 * which the "foreign origin" block covers.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const SW_SOURCE = readFileSync(
  resolve(__dirname, "../../public/sw.js"),
  "utf8",
);

const ORIGIN = "https://app.example";
// `importScripts` throws in the sandbox, so the in-`sw.js` fallback literal
// is active and the cache names are deterministic. The fallback is
// re-anchored to `package.json` on every prebuild by
// `scripts/generate-sw-version.mjs`; read it straight from the SW source so
// this test never drifts from the literal it is exercising.
const FALLBACK_VERSION = /\/\* @sw-version-fallback \*\/\s*"(v[^"]*)"/.exec(
  SW_SOURCE,
)![1];
const CURRENT_PAGE_CACHE = `healthlog-pages-${FALLBACK_VERSION}`;
const CURRENT_STATIC_CACHE = `healthlog-static-${FALLBACK_VERSION}`;
const CURRENT_DATA_CACHE = `healthlog-data-${FALLBACK_VERSION}`;

const PAGE_MARKER = "X-HealthLog-Page";

/** A page response as HealthLog's proxy delivers it: marker included. */
function healthlogPage(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set(PAGE_MARKER, "1");
  return new Response(body, { ...init, headers });
}

class FakeCache {
  map = new Map<string, Response>();
  keysCalls = 0;
  putError: Error | undefined;
  putDelay: Promise<void> | undefined;
  onPut: (() => void) | undefined;
  keysError: Error | undefined;
  addAllResponse:
    ((request: Request) => Promise<Response> | Response) | undefined;

  private keyOf(request: RequestInfo | URL): string {
    if (typeof request === "string") return new URL(request, ORIGIN).href;
    if (request instanceof URL) return request.href;
    return request.url;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.map.get(this.keyOf(request));
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.onPut?.();
    if (this.putDelay) await this.putDelay;
    if (this.putError) throw this.putError;
    this.map.set(this.keyOf(request), response);
  }

  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) {
      const request = new Request(new URL(url, ORIGIN), {
        credentials: "same-origin",
      });
      const response = this.addAllResponse
        ? await this.addAllResponse(request)
        : new Response(`precached:${url}`);
      this.map.set(this.keyOf(request), response);
    }
  }

  async keys(): Promise<Request[]> {
    this.keysCalls += 1;
    if (this.keysError) throw this.keysError;
    return [...this.map.keys()].map((url) => new Request(url));
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.map.delete(this.keyOf(request));
  }
}

class FakeCacheStorage {
  stores = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let store = this.stores.get(name);
    if (!store) {
      store = new FakeCache();
      this.stores.set(name, store);
    }
    return store;
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const store of this.stores.values()) {
      const hit = await store.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

interface SwHarness {
  listeners: Map<string, (event: unknown) => void>;
  cacheStorage: FakeCacheStorage;
  navPreload: { enabled: boolean; enable: () => Promise<void> };
  unregisterCalls: { count: number };
  /** What `pushManager.getSubscription()` does; default: no subscription. */
  push: { getSubscription: () => Promise<unknown> };
  lifetimePromises: Promise<unknown>[];
  context: Record<string, unknown>;
}

function bootServiceWorker(): SwHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStorage = new FakeCacheStorage();
  const lifetimePromises: Promise<unknown>[] = [];
  const unregisterCalls = { count: 0 };
  const push = { getSubscription: async (): Promise<unknown> => null };
  const navPreload = {
    enabled: false,
    enable: async () => {
      navPreload.enabled = true;
    },
  };
  // v1.18.4 — push-handler fakes: a notification store the `getNotifications`
  // / `showNotification` calls read/write, and a Badging-API spy.
  const shown: Array<{ title: string; tag?: string; closed: boolean }> = [];
  const badge = { value: undefined as number | undefined, cleared: false };
  const selfObj = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.set(type, fn);
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {
      navigationPreload: navPreload,
      unregister: async () => {
        unregisterCalls.count += 1;
        return true;
      },
      pushManager: {
        getSubscription: () => push.getSubscription(),
      },
      showNotification: async (title: string, opts: { tag?: string }) => {
        shown.push({ title, tag: opts?.tag, closed: false });
      },
      getNotifications: async ({ tag }: { tag?: string }) =>
        shown
          .filter((n) => !n.closed && (tag === undefined || n.tag === tag))
          .map((n) => ({
            close: () => {
              n.closed = true;
            },
          })),
    },
    navigator: {
      setAppBadge: (n: number) => {
        badge.value = n;
      },
      clearAppBadge: () => {
        badge.cleared = true;
        badge.value = undefined;
      },
    },
    location: { origin: ORIGIN },
  };
  (
    selfObj as unknown as { __shown: typeof shown; __badge: typeof badge }
  ).__shown = shown;
  (
    selfObj as unknown as { __shown: typeof shown; __badge: typeof badge }
  ).__badge = badge;
  const context: Record<string, unknown> = {
    self: selfObj,
    caches: cacheStorage,
    importScripts: () => {
      throw new Error("no generated version file in the sandbox");
    },
    // Default: network down. Individual tests override `context.fetch`.
    fetch: async () => {
      throw new TypeError("network down");
    },
    Response,
    Request,
    URL,
    Promise,
    console,
    // Read through the context so a test can install fake timers before
    // dispatching (the slow-navigation fallback arms one per navigation).
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context);
  return {
    listeners,
    cacheStorage,
    navPreload,
    unregisterCalls,
    push,
    lifetimePromises,
    context,
  };
}

async function dispatchActivate(harness: SwHarness): Promise<void> {
  let settled: Promise<unknown> = Promise.resolve();
  harness.listeners.get("activate")!({
    waitUntil: (p: Promise<unknown>) => {
      settled = p;
    },
  });
  await settled;
}

async function dispatchInstall(harness: SwHarness): Promise<void> {
  let settled: Promise<unknown> = Promise.resolve();
  harness.listeners.get("install")!({
    waitUntil: (p: Promise<unknown>) => {
      settled = p;
    },
  });
  await settled;
}

function dispatchNavigationFetch(
  harness: SwHarness,
  path: string,
  preloadResponse?: Promise<Response | undefined>,
): Promise<Response> {
  let captured: Promise<Response> | null = null;
  harness.listeners.get("fetch")!({
    request: new Request(`${ORIGIN}${path}`, {
      headers: { accept: "text/html" },
    }),
    respondWith: (p: Promise<Response>) => {
      captured = p;
    },
    preloadResponse,
    waitUntil: (p: Promise<unknown>) => {
      harness.lifetimePromises.push(p);
    },
  });
  if (!captured) throw new Error("fetch handler did not respond");
  return captured;
}

function dispatchApiFetch(harness: SwHarness, path: string): Promise<Response> {
  let captured: Promise<Response> | null = null;
  harness.listeners.get("fetch")!({
    request: new Request(`${ORIGIN}${path}`),
    respondWith: (p: Promise<Response>) => {
      captured = p;
    },
  });
  if (!captured) throw new Error("fetch handler did not respond");
  return captured;
}

function dispatchAssetFetch(
  harness: SwHarness,
  path: string,
): Promise<Response> {
  let captured: Promise<Response> | null = null;
  harness.listeners.get("fetch")!({
    request: new Request(`${ORIGIN}${path}`),
    respondWith: (p: Promise<Response>) => {
      captured = p;
    },
  });
  if (!captured) throw new Error("fetch handler did not respond");
  return captured;
}

/**
 * Dispatch a top-level navigation the way the browser does when navigation
 * preload is enabled — with a `preloadResponse` promise already in flight.
 * Unlike the other dispatchers this one does NOT throw when the handler
 * declines to respond: whether `respondWith` was called is exactly what the
 * one-shot-auth-navigation test asserts (no `respondWith` ⇒ the browser also
 * runs its own default fetch ⇒ the request is sent twice).
 */
function dispatchAuthNavigation(
  harness: SwHarness,
  path: string,
  preloadResponse?: Promise<Response | undefined>,
): { responded: boolean; response: Promise<Response> | null } {
  let captured: Promise<Response> | null = null;
  let responded = false;
  harness.listeners.get("fetch")!({
    request: new Request(`${ORIGIN}${path}`, {
      headers: { accept: "text/html" },
    }),
    respondWith: (p: Promise<Response>) => {
      responded = true;
      captured = p;
    },
    preloadResponse,
    waitUntil: (p: Promise<unknown>) => {
      harness.lifetimePromises.push(p);
    },
  });
  return { responded, response: captured };
}

describe("sw.js — one-shot auth navigations", () => {
  it("settles an OIDC callback navigation itself, consuming the preload (single request)", async () => {
    const harness = bootServiceWorker();
    let fetchCalls = 0;
    harness.context.fetch = async () => {
      fetchCalls += 1;
      return new Response("network callback");
    };

    const { responded, response } = dispatchAuthNavigation(
      harness,
      "/api/auth/oidc/callback?code=abc&state=xyz",
      Promise.resolve(new Response("preloaded callback")),
    );

    // The SW settles the event, so the browser does NOT also run its own
    // default navigation fetch — the single-use OIDC code reaches the server
    // exactly once. (Without this the handler returned early with no
    // `respondWith`, and the preload + default fetch redeemed the code twice.)
    expect(responded).toBe(true);
    // The already-in-flight preload response is the one used; no extra fetch.
    expect(await (await response!).text()).toBe("preloaded callback");
    expect(fetchCalls).toBe(0);
  });

  it("fetches an auth navigation exactly once when no preload is supplied", async () => {
    const harness = bootServiceWorker();
    let fetchCalls = 0;
    harness.context.fetch = async () => {
      fetchCalls += 1;
      return new Response("network callback");
    };

    const { responded, response } = dispatchAuthNavigation(
      harness,
      "/api/auth/oidc/login?next=%2F",
    );

    expect(responded).toBe(true);
    expect(await (await response!).text()).toBe("network callback");
    expect(fetchCalls).toBe(1);
  });

  it("never caches an auth navigation response", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () => new Response("network callback");

    const url = "/api/auth/oidc/callback?code=abc&state=xyz";
    await dispatchAuthNavigation(harness, url).response;
    await Promise.all(harness.lifetimePromises);

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}${url}`)).toBeUndefined();
    const data = await harness.cacheStorage.open(CURRENT_DATA_CACHE);
    expect(await data.match(`${ORIGIN}${url}`)).toBeUndefined();
  });
});

describe("sw.js — best-effort cache writes", () => {
  it("returns the original successful API response when cache.put rejects", async () => {
    const harness = bootServiceWorker();
    const dataCache = await harness.cacheStorage.open(CURRENT_DATA_CACHE);
    dataCache.putError = new Error("CacheStorage quota exceeded");
    const networkResponse = new Response(
      JSON.stringify({ data: { weightKg: 80 }, error: null }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Network-Response": "original",
        },
      },
    );
    harness.context.fetch = async () => networkResponse;

    const response = await dispatchApiFetch(
      harness,
      "/api/measurements?type=WEIGHT",
    );

    expect(response).toBe(networkResponse);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Network-Response")).toBe("original");
    expect(await response.text()).toBe(
      JSON.stringify({ data: { weightKg: 80 }, error: null }),
    );
  });

  it("returns the original successful navigation response when cache.put rejects", async () => {
    const harness = bootServiceWorker();
    const pageCache = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    pageCache.putError = new Error("CacheStorage quota exceeded");
    const networkResponse = healthlogPage("network shell", {
      headers: { "X-Network-Response": "original" },
    });
    harness.context.fetch = async () => networkResponse;

    const response = await dispatchNavigationFetch(harness, "/measurements");

    expect(response).toBe(networkResponse);
    expect(response.headers.get("X-Network-Response")).toBe("original");
    expect(await response.text()).toBe("network shell");
  });

  it("does not delay a successful navigation response while cache.put is pending", async () => {
    const harness = bootServiceWorker();
    const pageCache = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    let releasePut!: () => void;
    pageCache.putDelay = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let notifyPutStarted!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      notifyPutStarted = resolve;
    });
    pageCache.onPut = notifyPutStarted;
    const networkResponse = healthlogPage("network shell");
    harness.context.fetch = async () => networkResponse;

    const responsePromise = dispatchNavigationFetch(harness, "/measurements");
    await putStarted;

    let settledResponse: Response | undefined;
    void responsePromise.then((response) => {
      settledResponse = response;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settledResponse).toBe(networkResponse);
      expect(harness.lifetimePromises).toHaveLength(1);
    } finally {
      releasePut();
      await Promise.all(harness.lifetimePromises);
    }

    expect(await pageCache.match(`${ORIGIN}/measurements`)).toBeDefined();
  });

  it("returns the original successful static response when cache.put rejects", async () => {
    const harness = bootServiceWorker();
    const staticCache = await harness.cacheStorage.open(CURRENT_STATIC_CACHE);
    staticCache.putError = new Error("CacheStorage quota exceeded");
    const networkResponse = new Response("immutable chunk", {
      headers: { "X-Network-Response": "original" },
    });
    harness.context.fetch = async () => networkResponse;

    const response = await dispatchAssetFetch(
      harness,
      "/_next/static/chunks/app.js",
    );

    expect(response).toBe(networkResponse);
    expect(response.headers.get("X-Network-Response")).toBe("original");
    expect(await response.text()).toBe("immutable chunk");
  });

  it("returns the original successful API response when cache trimming rejects", async () => {
    const harness = bootServiceWorker();
    const dataCache = await harness.cacheStorage.open(CURRENT_DATA_CACHE);
    dataCache.keysError = new Error("CacheStorage keys unavailable");
    const networkResponse = new Response(
      JSON.stringify({ data: { weightKg: 80 }, error: null }),
      { headers: { "Content-Type": "application/json" } },
    );
    harness.context.fetch = async () => networkResponse;

    const response = await dispatchApiFetch(harness, "/api/measurements");

    expect(response).toBe(networkResponse);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      JSON.stringify({ data: { weightKg: 80 }, error: null }),
    );
    expect(dataCache.keysCalls).toBe(1);
  });
});

describe("sw.js — activate", () => {
  it("drops stale-version caches and enables navigation preload", async () => {
    const harness = bootServiceWorker();
    const stale = await harness.cacheStorage.open("healthlog-pages-v0.0.1");
    await stale.put(`${ORIGIN}/`, new Response("stale shell"));
    await harness.cacheStorage.open(CURRENT_PAGE_CACHE);

    await dispatchActivate(harness);

    expect(harness.cacheStorage.stores.has("healthlog-pages-v0.0.1")).toBe(
      false,
    );
    expect(harness.cacheStorage.stores.has(CURRENT_PAGE_CACHE)).toBe(true);
    expect(harness.navPreload.enabled).toBe(true);
  });
});

describe("sw.js — authenticated install cache isolation", () => {
  it("never requests or stores signed-in root HTML while retaining public immutable assets", async () => {
    const harness = bootServiceWorker();
    const statics = await harness.cacheStorage.open(CURRENT_STATIC_CACHE);
    const requested: Request[] = [];
    const healthSentinel = "PRIVATE_DASHBOARD_WEIGHT_81_7_KG";
    statics.addAllResponse = async (request) => {
      requested.push(request);
      return new Response(
        new URL(request.url).pathname === "/"
          ? `<html><body>${healthSentinel}</body></html>`
          : `public-asset:${new URL(request.url).pathname}`,
      );
    };

    await dispatchInstall(harness);

    expect
      .soft(requested.map((request) => new URL(request.url).pathname))
      .not.toContain("/");
    expect
      .soft(requested.every((request) => request.credentials === "same-origin"))
      .toBe(true);
    const cachedBodies = await Promise.all(
      [...statics.map.values()].map((response) => response.clone().text()),
    );
    expect.soft(cachedBodies.join("\n")).not.toContain(healthSentinel);
    expect(await statics.match(`${ORIGIN}/logo-192.png`)).toBeDefined();

    const offline = await dispatchNavigationFetch(harness, "/");
    const offlineBody = await offline.text();
    expect.soft(offline.status).toBe(503);
    expect.soft(offlineBody).toContain("Offline");
    expect(offlineBody).not.toContain(healthSentinel);
  });
});

describe("sw.js — networkFirst offline fallback", () => {
  it("never serves a shell cached under a previous CACHE_VERSION", async () => {
    const harness = bootServiceWorker();
    // A stale pre-update cache that survived into the activation gap.
    const stale = await harness.cacheStorage.open("healthlog-pages-v0.0.1");
    await stale.put(`${ORIGIN}/`, new Response("stale shell"));

    const res = await dispatchNavigationFetch(harness, "/");

    // The stale shell is ignored; the language-neutral offline page wins.
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Offline");
  });

  it("serves the current-version page cache when offline", async () => {
    const harness = bootServiceWorker();
    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    await pages.put(`${ORIGIN}/`, new Response("current shell"));

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.text()).toBe("current shell");
  });

  it("falls back to the current-version precached shell when the page cache misses", async () => {
    const harness = bootServiceWorker();
    const statics = await harness.cacheStorage.open(CURRENT_STATIC_CACHE);
    await statics.addAll(["/"]);

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.text()).toBe("precached:/");
  });

  it("consumes the navigation-preload response instead of re-fetching", async () => {
    const harness = bootServiceWorker();
    let fetchCalls = 0;
    harness.context.fetch = async () => {
      fetchCalls += 1;
      return new Response("network shell");
    };

    const res = await dispatchNavigationFetch(
      harness,
      "/",
      Promise.resolve(healthlogPage("preloaded shell")),
    );

    expect(await res.clone().text()).toBe("preloaded shell");
    expect(fetchCalls).toBe(0);
    // The preloaded response was cached under the current page cache.
    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/`)).toBeDefined();
  });
});

describe("sw.js — offline page", () => {
  it("offers a retry control, reloads by itself when the connection returns, and follows the device scheme", async () => {
    const harness = bootServiceWorker();
    const res = await dispatchNavigationFetch(harness, "/");
    expect(res.status).toBe(503);
    const html = await res.text();
    // A real control, not a decorative icon: a link back to the same URL.
    expect(html).toMatch(/<a href="" aria-label="[^"]+"/);
    expect(html).toContain('addEventListener("online"');
    expect(html).toContain("prefers-color-scheme:light");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("env(safe-area-inset-bottom)");
    // Still language-neutral: no sentence in any one locale.
    expect(html).not.toMatch(/Keine Verbindung|You are offline/);
  });
});

describe("sw.js — networkFirst privacy gate", () => {
  it("does not cache a navigation response that carries Cache-Control: no-store", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () =>
      healthlogPage("private shell", {
        headers: { "Cache-Control": "no-store" },
      });

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.clone().text()).toBe("private shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/`)).toBeUndefined();
  });

  it("does not cache the /c/ clinician-share view even without no-store", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () => healthlogPage("share shell");

    const res = await dispatchNavigationFetch(harness, "/c/hls_abc123");
    expect(await res.clone().text()).toBe("share shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/c/hls_abc123`)).toBeUndefined();
  });

  it("still caches an ordinary navigation response", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () => healthlogPage("app shell");

    const res = await dispatchNavigationFetch(harness, "/measurements");
    expect(await res.clone().text()).toBe("app shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/measurements`)).toBeDefined();
  });
});

/**
 * Dispatch any request and report whether the worker took it. Used where the
 * assertion IS whether `respondWith` was called: a declined request goes to
 * the network through the browser, untouched by this worker.
 */
function dispatchAnyFetch(
  harness: SwHarness,
  path: string,
  headers: Record<string, string> = {},
): { responded: boolean; response: Promise<Response> | null } {
  let captured: Promise<Response> | null = null;
  let responded = false;
  harness.listeners.get("fetch")!({
    request: new Request(`${ORIGIN}${path}`, { headers }),
    respondWith: (p: Promise<Response>) => {
      responded = true;
      captured = p;
    },
    waitUntil: (p: Promise<unknown>) => {
      harness.lifetimePromises.push(p);
    },
  });
  return { responded, response: captured };
}

const HEALTHLOG_VERSION_BODY = JSON.stringify({
  data: { version: "1.38.21", buildSha: null, builtAt: null },
  error: null,
});

/**
 * Route the harness `fetch`: `/api/version` (the worker's confirmation probe)
 * gets `version`, everything else gets `page`. Records every requested path.
 */
function routeFetch(
  harness: SwHarness,
  page: () => Response,
  version: () => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  harness.context.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      ORIGIN,
    );
    calls.push(url.pathname);
    return url.pathname === "/api/version" ? version() : page();
  };
  return calls;
}

const foreignHtml = () =>
  new Response("<html>another app</html>", {
    headers: { "Content-Type": "text/html" },
  });

async function seedHealthlogCaches(harness: SwHarness): Promise<void> {
  const statics = await harness.cacheStorage.open(CURRENT_STATIC_CACHE);
  await statics.put(
    `${ORIGIN}/_next/static/chunks/app.js`,
    new Response("healthlog chunk"),
  );
  const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
  await pages.put(`${ORIGIN}/`, healthlogPage("healthlog shell"));
  const legacy = await harness.cacheStorage.open("healthlog-data-v0.0.1");
  await legacy.put(`${ORIGIN}/api/version`, new Response("{}"));
  // CacheStorage the other app owns on the same origin.
  const other = await harness.cacheStorage.open("next-app-runtime");
  await other.put(`${ORIGIN}/x`, new Response("theirs"));
}

describe("sw.js — foreign origin (#847)", () => {
  it("keeps serving and caching while the page carries the HealthLog marker", async () => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    harness.context.fetch = async () => healthlogPage("fresh shell");

    const res = await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(await res.text()).toBe("fresh shell");
    expect(harness.unregisterCalls.count).toBe(0);
    expect(harness.cacheStorage.stores.has(CURRENT_STATIC_CACHE)).toBe(true);
    const asset = dispatchAnyFetch(harness, "/_next/static/chunks/app.js");
    expect(asset.responded).toBe(true);
    expect(await (await asset.response!).text()).toBe("healthlog chunk");
  });

  it("retires when the page lacks the marker and the version probe finds another app's HTML", async () => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    const foreignPage = foreignHtml();
    const calls = routeFetch(harness, () => foreignPage, foreignHtml);

    const res = await dispatchNavigationFetch(harness, "/");

    // The other app's page is returned untouched, and the worker declines
    // requests at once, before the probe has answered.
    expect(res).toBe(foreignPage);
    expect(
      dispatchAnyFetch(harness, "/_next/static/chunks/app.js").responded,
    ).toBe(false);

    await Promise.all(harness.lifetimePromises);

    expect(calls).toEqual(["/", "/api/version"]);
    expect(harness.unregisterCalls.count).toBe(1);
    // Every HealthLog cache is gone, current and legacy; the other app's is not.
    expect([...harness.cacheStorage.stores.keys()]).toEqual([
      "next-app-runtime",
    ]);

    // Still declining after the retire: static, HTML and API all go to the
    // network through the browser.
    expect(
      dispatchAnyFetch(harness, "/_next/static/chunks/app.js").responded,
    ).toBe(false);
    expect(
      dispatchAnyFetch(harness, "/about", { accept: "text/html" }).responded,
    ).toBe(false);
    expect(dispatchAnyFetch(harness, "/api/measurements").responded).toBe(
      false,
    );
  });

  it("retires when the version probe answers 404", async () => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    routeFetch(
      harness,
      foreignHtml,
      () => new Response("Not Found", { status: 404 }),
    );

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(harness.unregisterCalls.count).toBe(1);
    expect(harness.cacheStorage.stores.has(CURRENT_STATIC_CACHE)).toBe(false);
  });

  it("retires when the version probe answers JSON without the HealthLog shape", async () => {
    const harness = bootServiceWorker();
    routeFetch(
      harness,
      foreignHtml,
      () => new Response(JSON.stringify({ version: "3.0.0" })),
    );

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(harness.unregisterCalls.count).toBe(1);
  });

  it("probes with no-store, a manual redirect and same-origin credentials", async () => {
    const harness = bootServiceWorker();
    let probeInit: RequestInit | undefined;
    harness.context.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const path = new URL(
        String(input instanceof Request ? input.url : input),
        ORIGIN,
      ).pathname;
      if (path === "/api/version") {
        probeInit = init;
        return new Response(HEALTHLOG_VERSION_BODY);
      }
      return foreignHtml();
    };

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(probeInit?.cache).toBe("no-store");
    expect(probeInit?.redirect).toBe("manual");
    // A valid same-origin gateway cookie must reach /api/version.
    expect(probeInit?.credentials).toBe("same-origin");
  });

  it("does not retire when a header-stripping proxy hides the marker from a real HealthLog", async () => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    // The page is HealthLog's, minus the marker a proxy allowlist removed.
    routeFetch(
      harness,
      () => new Response("healthlog page without marker"),
      () =>
        new Response(HEALTHLOG_VERSION_BODY, {
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.text()).toBe("healthlog page without marker");
    await Promise.all(harness.lifetimePromises);

    expect(harness.unregisterCalls.count).toBe(0);
    expect(harness.cacheStorage.stores.has(CURRENT_STATIC_CACHE)).toBe(true);
    // Normal service resumed: the cached chunk is served cache-first again.
    const asset = dispatchAnyFetch(harness, "/_next/static/chunks/app.js");
    expect(asset.responded).toBe(true);
    expect(await (await asset.response!).text()).toBe("healthlog chunk");
  });

  it.each([
    [
      "the probe throws (network)",
      () => Promise.reject(new TypeError("network down")),
    ],
    ["the probe answers 500", () => new Response("boom", { status: 500 })],
    [
      "the probe answers 401 from an auth gateway",
      () => new Response("Unauthorized", { status: 401 }),
    ],
  ])(
    "does not retire when %s, and resumes service",
    async (_label, version) => {
      const harness = bootServiceWorker();
      await seedHealthlogCaches(harness);
      routeFetch(harness, foreignHtml, version as () => Promise<Response>);

      await dispatchNavigationFetch(harness, "/");
      await Promise.all(harness.lifetimePromises);

      expect(harness.unregisterCalls.count).toBe(0);
      expect(harness.cacheStorage.stores.has(CURRENT_STATIC_CACHE)).toBe(true);
      expect(
        dispatchAnyFetch(harness, "/_next/static/chunks/app.js").responded,
      ).toBe(true);
    },
  );

  it("asks again on a later suspicious navigation after an inconclusive probe", async () => {
    const harness = bootServiceWorker();
    let probeStatus = 503;
    const calls = routeFetch(harness, foreignHtml, () =>
      probeStatus === 503
        ? new Response("down", { status: 503 })
        : new Response("Not Found", { status: 404 }),
    );

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);
    expect(harness.unregisterCalls.count).toBe(0);

    probeStatus = 404;
    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(calls.filter((p) => p === "/api/version")).toHaveLength(2);
    expect(harness.unregisterCalls.count).toBe(1);
  });

  it("recognises a foreign page delivered through navigation preload", async () => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    const calls = routeFetch(
      harness,
      () => healthlogPage("unexpected"),
      () => new Response("Not Found", { status: 404 }),
    );

    const res = await dispatchNavigationFetch(
      harness,
      "/",
      Promise.resolve(new Response("another app")),
    );
    await Promise.all(harness.lifetimePromises);

    expect(await res.text()).toBe("another app");
    // The page came from the preload; the only network call is the probe.
    expect(calls).toEqual(["/api/version"]);
    expect(harness.unregisterCalls.count).toBe(1);
  });

  it("keeps a worker that holds a push subscription: caches deleted, no unregister, pass-through", async () => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    harness.push.getSubscription = async () => ({
      endpoint: "https://push.example/abc",
    });
    // A gateway's 200 sign-in page for both the navigation and the probe.
    routeFetch(harness, foreignHtml, foreignHtml);

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(harness.unregisterCalls.count).toBe(0);
    expect([...harness.cacheStorage.stores.keys()]).toEqual([
      "next-app-runtime",
    ]);
    expect(
      dispatchAnyFetch(harness, "/_next/static/chunks/app.js").responded,
    ).toBe(false);
    expect(
      dispatchAnyFetch(harness, "/about", { accept: "text/html" }).responded,
    ).toBe(false);
  });

  it.each([
    [
      "the subscription lookup throws",
      (h: SwHarness) => {
        h.push.getSubscription = async () => {
          throw new Error("push service unavailable");
        };
      },
    ],
    [
      "pushManager is missing",
      (h: SwHarness) => {
        delete (h.context.self as { registration: { pushManager?: unknown } })
          .registration.pushManager;
      },
    ],
  ])("does not unregister when %s", async (_label, arrange) => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    arrange(harness);
    routeFetch(harness, foreignHtml, foreignHtml);

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(harness.unregisterCalls.count).toBe(0);
    expect(harness.cacheStorage.stores.has(CURRENT_STATIC_CACHE)).toBe(false);
  });

  it("still unregisters when deleting the caches fails", async () => {
    const harness = bootServiceWorker();
    harness.cacheStorage.keys = async () => {
      throw new Error("CacheStorage unavailable");
    };
    routeFetch(harness, foreignHtml, foreignHtml);

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(harness.unregisterCalls.count).toBe(1);
  });

  it("keeps the offline fallback when the network fails (HealthLog is down, not replaced)", async () => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    // Default harness fetch throws: network down.

    const res = await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(await res.text()).toBe("healthlog shell");
    expect(harness.unregisterCalls.count).toBe(0);
    expect(harness.cacheStorage.stores.has(CURRENT_STATIC_CACHE)).toBe(true);
  });

  it.each([
    [
      "an error page from HealthLog itself",
      healthlogPage("boom", { status: 500 }),
    ],
    [
      "a gateway error from a proxy in front of a stopped HealthLog",
      new Response("Bad Gateway", { status: 502 }),
    ],
    [
      "a 401 from an auth gateway",
      new Response("Unauthorized", { status: 401 }),
    ],
  ])("does not treat %s as foreign", async (_label, response) => {
    const harness = bootServiceWorker();
    await seedHealthlogCaches(harness);
    harness.context.fetch = async () => response;

    const res = await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(res).toBe(response);
    expect(harness.unregisterCalls.count).toBe(0);
    expect(
      dispatchAnyFetch(harness, "/_next/static/chunks/app.js").responded,
    ).toBe(true);
  });

  it("does not treat an opaque redirect (a signed-out HealthLog page) as foreign", async () => {
    const harness = bootServiceWorker();
    const redirect = Response.redirect(`${ORIGIN}/auth/login`, 307);
    // A navigation fetched with `redirect: "manual"` surfaces as an opaque
    // redirect in a real worker; model the type the worker sees.
    Object.defineProperty(redirect, "type", { value: "opaqueredirect" });
    Object.defineProperty(redirect, "headers", { value: new Headers() });
    Object.defineProperty(redirect, "ok", { value: false });
    harness.context.fetch = async () => redirect;

    await dispatchNavigationFetch(harness, "/");
    await Promise.all(harness.lifetimePromises);

    expect(harness.unregisterCalls.count).toBe(0);
  });

  it("leaves the one-shot auth navigation path unchanged", async () => {
    const harness = bootServiceWorker();
    let fetchCalls = 0;
    harness.context.fetch = async () => {
      fetchCalls += 1;
      return new Response("network callback");
    };

    const { responded, response } = dispatchAuthNavigation(
      harness,
      "/api/auth/oidc/callback?code=abc&state=xyz",
      Promise.resolve(new Response("preloaded callback")),
    );

    expect(responded).toBe(true);
    expect(await (await response!).text()).toBe("preloaded callback");
    expect(fetchCalls).toBe(0);
    // An auth response has no page marker and must not retire the worker.
    await Promise.all(harness.lifetimePromises);
    expect(harness.unregisterCalls.count).toBe(0);
  });
});

describe("sw.js — trimCache", () => {
  it("reads the key list once and deletes only the oldest excess entries", async () => {
    const harness = bootServiceWorker();
    const store = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    for (let i = 0; i < 8; i++) {
      await store.put(`${ORIGIN}/page-${i}`, new Response(`p${i}`));
    }
    store.keysCalls = 0;

    const trimCache = (
      harness.context as {
        trimCache?: (name: string, max: number) => Promise<void>;
      }
    ).trimCache;
    expect(typeof trimCache).toBe("function");
    await trimCache!(CURRENT_PAGE_CACHE, 5);

    // Single key read (the previous implementation re-read per deletion).
    expect(store.keysCalls).toBe(1);
    // Oldest three gone, newest five kept.
    expect(store.map.has(`${ORIGIN}/page-0`)).toBe(false);
    expect(store.map.has(`${ORIGIN}/page-2`)).toBe(false);
    expect(store.map.has(`${ORIGIN}/page-3`)).toBe(true);
    expect(store.map.has(`${ORIGIN}/page-7`)).toBe(true);
  });
});

// ── push handler (v1.18.4: clear-on-taken tag close + app badge) ─────────────
async function dispatchPush(harness: SwHarness, data: unknown): Promise<void> {
  let settled: Promise<unknown> = Promise.resolve();
  harness.listeners.get("push")!({
    data: { json: () => data, text: () => JSON.stringify(data) },
    waitUntil: (p: Promise<unknown>) => {
      settled = p;
    },
  });
  await settled;
}

function swFakes(harness: SwHarness) {
  const selfObj = harness.context.self as unknown as {
    __shown: Array<{ title: string; tag?: string; closed: boolean }>;
    __badge: { value: number | undefined; cleared: boolean };
  };
  return { shown: selfObj.__shown, badge: selfObj.__badge };
}

describe("sw.js — push handler", () => {
  it("shows a reminder with its stable tag and sets the app badge", async () => {
    const harness = bootServiceWorker();
    const { shown, badge } = swFakes(harness);
    const tag = "med:med-1:2026-06-18T07:00:00.000Z";

    await dispatchPush(harness, {
      title: "Time for your dose",
      body: "Ramipril 5mg",
      tag,
      badge: 3,
    });

    expect(shown).toHaveLength(1);
    expect(shown[0].tag).toBe(tag);
    expect(badge.value).toBe(3);
  });

  it("a type:clear push closes the matching-tag notification (no new one) and updates the badge", async () => {
    const harness = bootServiceWorker();
    const { shown, badge } = swFakes(harness);
    const tag = "med:med-1:2026-06-18T07:00:00.000Z";

    await dispatchPush(harness, { title: "dose", tag, badge: 1 });
    expect(shown.filter((n) => !n.closed)).toHaveLength(1);

    await dispatchPush(harness, { type: "clear", tag, badge: 0 });

    // The pending reminder for that slot is closed; no new notification shown.
    expect(shown).toHaveLength(1);
    expect(shown[0].closed).toBe(true);
    // badge: 0 clears the app badge.
    expect(badge.cleared).toBe(true);
  });

  it("a type:clear push only closes its own slot's tag", async () => {
    const harness = bootServiceWorker();
    const { shown } = swFakes(harness);

    await dispatchPush(harness, { title: "a", tag: "med:a:t1" });
    await dispatchPush(harness, { title: "b", tag: "med:b:t2" });

    await dispatchPush(harness, { type: "clear", tag: "med:a:t1" });

    const a = shown.find((n) => n.tag === "med:a:t1")!;
    const b = shown.find((n) => n.tag === "med:b:t2")!;
    expect(a.closed).toBe(true);
    expect(b.closed).toBe(false);
  });
});
