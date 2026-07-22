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

class FakeCache {
  map = new Map<string, Response>();
  keysCalls = 0;
  putError: Error | undefined;
  putDelay: Promise<void> | undefined;
  onPut: (() => void) | undefined;
  keysError: Error | undefined;

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
      this.map.set(this.keyOf(url), new Response(`precached:${url}`));
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
  lifetimePromises: Promise<unknown>[];
  context: Record<string, unknown>;
}

function bootServiceWorker(): SwHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const cacheStorage = new FakeCacheStorage();
  const lifetimePromises: Promise<unknown>[] = [];
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
  };
  vm.createContext(context);
  vm.runInContext(SW_SOURCE, context);
  return { listeners, cacheStorage, navPreload, lifetimePromises, context };
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
    const networkResponse = new Response("network shell", {
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
    const networkResponse = new Response("network shell");
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
      Promise.resolve(new Response("preloaded shell")),
    );

    expect(await res.clone().text()).toBe("preloaded shell");
    expect(fetchCalls).toBe(0);
    // The preloaded response was cached under the current page cache.
    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/`)).toBeDefined();
  });
});

describe("sw.js — networkFirst privacy gate", () => {
  it("does not cache a navigation response that carries Cache-Control: no-store", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () =>
      new Response("private shell", {
        headers: { "Cache-Control": "no-store" },
      });

    const res = await dispatchNavigationFetch(harness, "/");
    expect(await res.clone().text()).toBe("private shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/`)).toBeUndefined();
  });

  it("does not cache the /c/ clinician-share view even without no-store", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () => new Response("share shell");

    const res = await dispatchNavigationFetch(harness, "/c/hls_abc123");
    expect(await res.clone().text()).toBe("share shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/c/hls_abc123`)).toBeUndefined();
  });

  it("still caches an ordinary navigation response", async () => {
    const harness = bootServiceWorker();
    harness.context.fetch = async () => new Response("app shell");

    const res = await dispatchNavigationFetch(harness, "/measurements");
    expect(await res.clone().text()).toBe("app shell");

    const pages = await harness.cacheStorage.open(CURRENT_PAGE_CACHE);
    expect(await pages.match(`${ORIGIN}/measurements`)).toBeDefined();
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
