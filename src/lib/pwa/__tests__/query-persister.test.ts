import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import {
  clearOfflineCachesForSessionEnd,
  clearPersistedQueryCache,
  isPersistableKey,
  restorePersistedQueryCache,
  startPersistingQueryCache,
} from "@/lib/pwa/query-persister";

describe("isPersistableKey — strict dashboard-offline allowlist", () => {
  it("persists ONLY the dashboard snapshot + measurement daily-series families", () => {
    // Dashboard snapshot — the unified first-paint read.
    expect(isPersistableKey(["dashboard", "snapshot"])).toBe(true);
    // Per-chart daily series + the batched dashboard series.
    expect(isPersistableKey(["chart-data", "WEIGHT"])).toBe(true);
    expect(isPersistableKey(["chart-data", "series-batch", "WEIGHT"])).toBe(
      true,
    );
    // The resolved widget layout the snapshot seeds — matched as an exact
    // tuple under the overloaded `["user", …]` head.
    expect(isPersistableKey(["user", "dashboardWidgets"])).toBe(true);
  });

  it("never persists clinical / narrative health families", () => {
    // The denylist regression: each of these used to be dehydrated to disk
    // in plaintext. They are health/clinical/narrative and must stay
    // in-memory only.
    expect(isPersistableKey(["coach", "conversations"])).toBe(false);
    expect(isPersistableKey(["insights"])).toBe(false);
    expect(isPersistableKey(["illness"])).toBe(false);
    expect(isPersistableKey(["labs"])).toBe(false);
    expect(isPersistableKey(["mood-entries"])).toBe(false);
    expect(isPersistableKey(["medications"])).toBe(false);
    expect(isPersistableKey(["cycle"])).toBe(false);
    expect(isPersistableKey(["measurements", "list"])).toBe(false);
    expect(isPersistableKey(["analytics"])).toBe(false);
  });

  it("never persists auth / session / admin / token families", () => {
    expect(isPersistableKey(["auth", "me"])).toBe(false);
    expect(isPersistableKey(["session"])).toBe(false);
    expect(isPersistableKey(["admin", "users"])).toBe(false);
    expect(isPersistableKey(["tokens"])).toBe(false);
    expect(isPersistableKey(["apiTokens"])).toBe(false);
  });

  it("never persists the rest of the overloaded user head", () => {
    expect(isPersistableKey(["user", "profile"])).toBe(false);
    expect(isPersistableKey(["user", "ai-provider"])).toBe(false);
    expect(isPersistableKey(["user", "insightsLayout"])).toBe(false);
    expect(isPersistableKey(["user", "thresholds"])).toBe(false);
  });
});

describe("persister degrades gracefully without IndexedDB", () => {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;

  beforeEach(() => {
    // jsdom/node here has no indexedDB; assert the guards no-op cleanly.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  });

  afterEach(() => {
    if (original !== undefined) {
      (globalThis as { indexedDB?: unknown }).indexedDB = original;
    }
  });

  it("restore resolves without throwing", async () => {
    const qc = new QueryClient();
    await expect(
      restorePersistedQueryCache(qc, "v1.18.6"),
    ).resolves.toBeUndefined();
  });

  it("start returns a callable no-op unsubscribe", () => {
    const qc = new QueryClient();
    const stop = startPersistingQueryCache(qc, "v1.18.6");
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("clear resolves without throwing", async () => {
    await expect(clearPersistedQueryCache()).resolves.toBeUndefined();
  });
});

describe("session-end CacheStorage cleanup", () => {
  const originalCaches = (globalThis as { caches?: CacheStorage }).caches;

  afterEach(() => {
    if (originalCaches === undefined) {
      delete (globalThis as { caches?: CacheStorage }).caches;
    } else {
      (globalThis as { caches?: CacheStorage }).caches = originalCaches;
    }
  });

  it("deletes current and legacy HealthLog page and data caches only", async () => {
    const cacheNames = [
      "healthlog-static-v1.34.0",
      "healthlog-static-v1.15.20",
      "healthlog-pages-v1.34.0",
      "healthlog-pages-v1.15.20",
      "healthlog-data-v1.34.0",
      "healthlog-data-v1.15.20",
      "unrelated-app-static-v7",
      "workbox-precache-healthlog",
    ];
    const deleted: string[] = [];
    (globalThis as { caches?: CacheStorage }).caches = {
      keys: async () => cacheNames,
      delete: async (name: string) => {
        deleted.push(name);
        return true;
      },
    } as CacheStorage;

    await clearOfflineCachesForSessionEnd();

    expect
      .soft(deleted.sort())
      .toEqual(
        cacheNames
          .filter((name) => /^healthlog-(?:pages|data)-/.test(name))
          .sort(),
      );
    // The static cache holds catalogs and icons, nothing of an account.
    expect(deleted).not.toContain("healthlog-static-v1.34.0");
    expect(deleted).not.toContain("unrelated-app-static-v7");
    expect(deleted).not.toContain("workbox-precache-healthlog");
  });
});

describe("persister round-trips through a fake IndexedDB", () => {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;

  afterEach(() => {
    if (original !== undefined) {
      (globalThis as { indexedDB?: unknown }).indexedDB = original;
    } else {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
    vi.restoreAllMocks();
  });

  it("hydrates a saved success result and skips a foreign build version", async () => {
    // Minimal in-memory IDB shim covering the open/put/get/delete the
    // persister uses. Avoids pulling a new dev dependency.
    const store = new Map<string, unknown>();
    const makeReq = (run: () => void) => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        run();
        (req.onsuccess as (() => void) | undefined)?.();
      });
      return req;
    };
    const fakeDb = {
      close() {},
      transaction() {
        return {
          objectStore() {
            return {
              put(value: unknown, key: string) {
                store.set(key, value);
                return makeReq(() => {});
              },
              get(key: string) {
                const req = makeReq(() => {});
                (req as { result?: unknown }).result = store.get(key);
                return req;
              },
              delete(key: string) {
                store.delete(key);
                return makeReq(() => {});
              },
            };
          },
          set oncomplete(fn: () => void) {
            queueMicrotask(fn);
          },
          set onerror(_fn: () => void) {},
        };
      },
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        const req: Record<string, unknown> = { result: fakeDb };
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    };

    const source = new QueryClient();
    source.setQueryData(["auth", "me"], { id: "user-a" });
    source.setQueryData(["dashboard", "snapshot"], { weightKg: 81 });
    const stop = startPersistingQueryCache(source, "v1.18.6");
    // Force a flush by advancing past the 1s debounce. The trigger write uses
    // an allowlisted family so the flush captures real persistable data.
    vi.useFakeTimers();
    source.setQueryData(["chart-data", "WEIGHT"], [{ d: "2026-06-18", v: 81 }]);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    stop();

    const matchingBuild = new QueryClient();
    matchingBuild.setQueryData(["auth", "me"], { id: "user-a" });
    await restorePersistedQueryCache(matchingBuild, "v1.18.6");
    expect(matchingBuild.getQueryData(["dashboard", "snapshot"])).toEqual({
      weightKg: 81,
    });

    // Restored data must paint instantly BUT be marked stale so the first
    // observer background-refetches — otherwise the client's 5-minute
    // staleTime treats a minutes-old snapshot as fresh and a list opened
    // right after a mutation serves the stale pre-mutation copy.
    const restored = matchingBuild
      .getQueryCache()
      .find({ queryKey: ["dashboard", "snapshot"] });
    expect(restored?.isStale()).toBe(true);

    const foreignBuild = new QueryClient();
    foreignBuild.setQueryData(["auth", "me"], { id: "user-a" });
    await restorePersistedQueryCache(foreignBuild, "v9.9.9");
    expect(
      foreignBuild.getQueryData(["dashboard", "snapshot"]),
    ).toBeUndefined();
  });

  it("never clobbers a query the live cache already holds", async () => {
    // The read-after-write invariant: restore runs in an effect, possibly
    // AFTER the page already fetched a fresh (post-mutation) list. A
    // persisted STALE copy under the same key must not overwrite it — a
    // present query is always fresher than disk.
    const store = new Map<string, unknown>();
    const makeReq = (run: () => void) => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        run();
        (req.onsuccess as (() => void) | undefined)?.();
      });
      return req;
    };
    const fakeDb = {
      close() {},
      transaction() {
        return {
          objectStore() {
            return {
              put(value: unknown, key: string) {
                store.set(key, value);
                return makeReq(() => {});
              },
              get(key: string) {
                const req = makeReq(() => {});
                (req as { result?: unknown }).result = store.get(key);
                return req;
              },
              delete(key: string) {
                store.delete(key);
                return makeReq(() => {});
              },
            };
          },
          set oncomplete(fn: () => void) {
            queueMicrotask(fn);
          },
          set onerror(_fn: () => void) {},
        };
      },
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        const req: Record<string, unknown> = { result: fakeDb };
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    };

    // Persist a STALE (empty) chart series under an allowlisted family.
    const source = new QueryClient();
    source.setQueryData(["auth", "me"], { id: "user-a" });
    source.setQueryData(["chart-data", "WEIGHT"], []);
    const stop = startPersistingQueryCache(source, "v1.18.6");
    vi.useFakeTimers();
    source.setQueryData(["chart-data", "WEIGHT"], []);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    stop();

    // The live client already fetched the FRESH (post-mutation) series.
    const live = new QueryClient();
    live.setQueryData(["auth", "me"], { id: "user-a" });
    live.setQueryData(["chart-data", "WEIGHT"], [{ id: "fresh-row" }]);

    await restorePersistedQueryCache(live, "v1.18.6");

    // The fresh row survived — the empty persisted snapshot did not win.
    expect(live.getQueryData(["chart-data", "WEIGHT"])).toEqual([
      { id: "fresh-row" },
    ]);

    // A query the page has started but not answered has no data: filled.
    const mounting = new QueryClient();
    mounting.setQueryData(["auth", "me"], { id: "user-a" });
    mounting
      .getQueryCache()
      .build(mounting, { queryKey: ["chart-data", "WEIGHT"] });
    await restorePersistedQueryCache(mounting, "v1.18.6");
    expect(mounting.getQueryData(["chart-data", "WEIGHT"])).toEqual([]);
  });

  it("discards a snapshot stamped with a different account id", async () => {
    const store = new Map<string, unknown>();
    const makeReq = (run: () => void) => {
      const req: Record<string, unknown> = {};
      queueMicrotask(() => {
        run();
        (req.onsuccess as (() => void) | undefined)?.();
      });
      return req;
    };
    const fakeDb = {
      close() {},
      transaction() {
        return {
          objectStore() {
            return {
              put(value: unknown, key: string) {
                store.set(key, value);
                return makeReq(() => {});
              },
              get(key: string) {
                const req = makeReq(() => {});
                (req as { result?: unknown }).result = store.get(key);
                return req;
              },
              delete(key: string) {
                store.delete(key);
                return makeReq(() => {});
              },
            };
          },
          set oncomplete(fn: () => void) {
            queueMicrotask(fn);
          },
          set onerror(_fn: () => void) {},
        };
      },
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        const req: Record<string, unknown> = { result: fakeDb };
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    };

    // Account "user-a" persists a dashboard snapshot. The persister stamps
    // the payload with the id read from the live `["auth","me"]` cache entry.
    const source = new QueryClient();
    source.setQueryData(["auth", "me"], { id: "user-a" });
    source.setQueryData(["dashboard", "snapshot"], { weightKg: 81 });
    const stop = startPersistingQueryCache(source, "v1.18.6");
    vi.useFakeTimers();
    source.setQueryData(["chart-data", "WEIGHT"], [{ v: 81 }]);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    stop();

    // A DIFFERENT account ("user-b") restores on the same browser profile:
    // the stamped owner mismatches the live account, so the snapshot is
    // discarded rather than hydrating user-a's dashboard into user-b's cache.
    const other = new QueryClient();
    other.setQueryData(["auth", "me"], { id: "user-b" });
    await restorePersistedQueryCache(other, "v1.18.6");
    expect(other.getQueryData(["dashboard", "snapshot"])).toBeUndefined();

    // ...and the foreign snapshot is wiped from disk, so a later same-account
    // restore can't resurrect it either.
    expect(store.get("react-query")).toBeUndefined();
  });

  it("restores nothing until the live account is known", async () => {
    installRoundTripIdb();
    const source = new QueryClient();
    source.setQueryData(["auth", "me"], { id: "user-a" });
    await persistOnce(source);

    // A cold start: the snapshot is on disk, `/api/auth/me` has not answered.
    const booting = new QueryClient();
    await restorePersistedQueryCache(booting, "v1.18.6");
    expect(booting.getQueryData(["dashboard", "snapshot"])).toBeUndefined();
    // Not discarded either: the account may well turn out to be its owner.
    expect(roundTripStore.get("react-query")).toBeDefined();

    booting.setQueryData(["auth", "me"], { id: "user-a" });
    await restorePersistedQueryCache(booting, "v1.18.6");
    expect(booting.getQueryData(["dashboard", "snapshot"])).toEqual({
      weightKg: 81,
    });
  });

  it("discards a snapshot written before any account was known", async () => {
    installRoundTripIdb();
    await persistOnce(new QueryClient());

    const live = new QueryClient();
    live.setQueryData(["auth", "me"], { id: "user-b" });
    await restorePersistedQueryCache(live, "v1.18.6");
    expect(live.getQueryData(["dashboard", "snapshot"])).toBeUndefined();
    expect(roundTripStore.get("react-query")).toBeUndefined();
  });
});

// ── shared fake IndexedDB for the account cases above ───────────────────────
const roundTripStore = new Map<string, unknown>();

function installRoundTripIdb(): void {
  roundTripStore.clear();
  const makeReq = (result?: unknown) => {
    const req: Record<string, unknown> = { result };
    queueMicrotask(() => (req.onsuccess as (() => void) | undefined)?.());
    return req;
  };
  const fakeDb = {
    close() {},
    transaction() {
      return {
        objectStore() {
          return {
            put(value: unknown, key: string) {
              roundTripStore.set(key, value);
              return makeReq();
            },
            get(key: string) {
              return makeReq(roundTripStore.get(key));
            },
            delete(key: string) {
              roundTripStore.delete(key);
              return makeReq();
            },
          };
        },
        set oncomplete(fn: () => void) {
          queueMicrotask(fn);
        },
        set onerror(_fn: () => void) {},
      };
    },
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open() {
      const req: Record<string, unknown> = { result: fakeDb };
      queueMicrotask(() => (req.onsuccess as () => void)?.());
      return req;
    },
  };
}

/** Write one dashboard snapshot from `source` through the 1 s debounce. */
async function persistOnce(source: QueryClient): Promise<void> {
  source.setQueryData(["dashboard", "snapshot"], { weightKg: 81 });
  const stop = startPersistingQueryCache(source, "v1.18.6");
  vi.useFakeTimers();
  source.setQueryData(["chart-data", "WEIGHT"], [{ v: 81 }]);
  vi.advanceTimersByTime(1100);
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  stop();
}

describe("persister is bounded and surfaces quota failures", () => {
  const original = (globalThis as { indexedDB?: unknown }).indexedDB;

  afterEach(() => {
    if (original !== undefined) {
      (globalThis as { indexedDB?: unknown }).indexedDB = original;
    } else {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    }
    vi.restoreAllMocks();
  });

  const makeReq = (run: () => void) => {
    const req: Record<string, unknown> = {};
    queueMicrotask(() => {
      run();
      (req.onsuccess as (() => void) | undefined)?.();
    });
    return req;
  };

  function installFakeIdb(opts: {
    onPut: (value: unknown, key: string) => void;
    store: Map<string, unknown>;
  }) {
    const fakeDb = {
      close() {},
      transaction() {
        return {
          objectStore() {
            return {
              put(value: unknown, key: string) {
                opts.onPut(value, key);
                return makeReq(() => {});
              },
              get(key: string) {
                const req = makeReq(() => {});
                (req as { result?: unknown }).result = opts.store.get(key);
                return req;
              },
              delete(key: string) {
                opts.store.delete(key);
                return makeReq(() => {});
              },
            };
          },
          set oncomplete(fn: () => void) {
            queueMicrotask(fn);
          },
          set onerror(_fn: () => void) {},
        };
      },
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open() {
        const req: Record<string, unknown> = { result: fakeDb };
        queueMicrotask(() => (req.onsuccess as () => void)?.());
        return req;
      },
    };
  }

  it("skips a snapshot that exceeds the size cap, leaving the last write intact", async () => {
    const store = new Map<string, unknown>();
    let putCount = 0;
    installFakeIdb({ store, onPut: () => (putCount += 1) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = new QueryClient();
    // A persistable family with a payload well over the 2 MB ceiling.
    const huge = "x".repeat(3 * 1024 * 1024);
    source.setQueryData(["chart-data", "WEIGHT"], [{ blob: huge }]);
    const stop = startPersistingQueryCache(source, "v1.18.6");
    vi.useFakeTimers();
    source.setQueryData(["chart-data", "WEIGHT"], [{ blob: huge }]);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    stop();

    // The oversized snapshot was never written, and the skip was logged
    // rather than silently dropped.
    expect(putCount).toBe(0);
    expect(store.get("react-query")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("clears the cache and warns on an IndexedDB quota error instead of swallowing it", async () => {
    const store = new Map<string, unknown>();
    let firstPut = true;
    installFakeIdb({
      store,
      onPut: (value, key) => {
        if (firstPut) {
          firstPut = false;
          // First write hits the storage quota.
          throw new DOMException("quota", "QuotaExceededError");
        }
        store.set(key, value);
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const source = new QueryClient();
    source.setQueryData(["dashboard", "snapshot"], { weightKg: 81 });
    const stop = startPersistingQueryCache(source, "v1.18.6");
    vi.useFakeTimers();
    source.setQueryData(["chart-data", "WEIGHT"], [{ v: 81 }]);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));
    // Let the clear-on-quota microtasks settle.
    await new Promise((r) => setTimeout(r, 0));
    stop();

    // The quota failure was surfaced, not swallowed, and the cache key was
    // cleared so the next flush has room.
    expect(warn).toHaveBeenCalled();
    expect(store.get("react-query")).toBeUndefined();
  });
});
