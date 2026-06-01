/**
 * Unit tests for the `ServerCache<T>` primitive — LRU ordering, TTL
 * expiry, capacity-cap eviction, prefix delete, single-flight
 * coalescing, builder-rejection cleanup, and the `cached()` wrapper's
 * observability annotation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetAllCachesForTests,
  cached,
  caches,
  hashCacheKey,
  ServerCache,
} from "../server-cache";

afterEach(() => {
  __resetAllCachesForTests();
  vi.useRealTimers();
});

describe("ServerCache.get / set", () => {
  it("returns the stored value within TTL", () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
  });

  it("returns null when the key is absent", () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    expect(cache.get("missing")).toBeNull();
  });

  it("expires entries past the TTL", () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 1000 });
    cache.set("k", "v");
    vi.advanceTimersByTime(999);
    expect(cache.get("k")).toBe("v");
    vi.advanceTimersByTime(2);
    expect(cache.get("k")).toBeNull();
  });
});

describe("ServerCache per-key TTL override", () => {
  it("set() honours a longer-than-default TTL for a single key", () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    cache.set("default", "v");
    cache.set("long", "v", 180_000);
    // Past the bucket default but inside the override.
    vi.advanceTimersByTime(60_001);
    expect(cache.get("default")).toBeNull();
    expect(cache.get("long")).toBe("v");
    // Past the override too.
    vi.advanceTimersByTime(120_000);
    expect(cache.get("long")).toBeNull();
  });

  it("wrap()/cached() thread the TTL override and stay evictable by prefix", async () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    await cached(cache, "u1|dashboard-snapshot", async () => "snap", undefined, 180_000);
    // Default bucket TTL elapsed; the override keeps the entry warm so
    // the 120 s client refetch interval lands on a hit, not a miss.
    vi.advanceTimersByTime(120_000);
    expect(cache.get("u1|dashboard-snapshot")).toBe("snap");
    // Invalidation still evicts regardless of the longer TTL.
    expect(cache.deleteByPrefix("u1|")).toBe(1);
    expect(cache.get("u1|dashboard-snapshot")).toBeNull();
  });
});

describe("ServerCache LRU eviction", () => {
  it("evicts the oldest entry on capacity overflow", () => {
    const cache = new ServerCache<number>({ maxEntries: 3, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    cache.set("d", 4); // evicts "a"
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
    expect(cache.stats().evictions).toBe(1);
  });

  it("touches on read so least-recently-used is evicted", () => {
    const cache = new ServerCache<number>({ maxEntries: 3, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Touch "a" — now "b" is the oldest.
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4); // evicts "b"
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("re-setting an existing key does not count toward eviction", () => {
    const cache = new ServerCache<number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 99); // overwrite, no eviction
    expect(cache.stats().evictions).toBe(0);
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBe(2);
  });
});

describe("ServerCache.deleteByPrefix", () => {
  it("removes every key with a matching prefix", () => {
    const cache = new ServerCache<number>({ maxEntries: 16, ttlMs: 60_000 });
    cache.set("user-1|analytics", 1);
    cache.set("user-1|workouts", 2);
    cache.set("user-2|analytics", 3);
    const removed = cache.deleteByPrefix("user-1|");
    expect(removed).toBe(2);
    expect(cache.get("user-1|analytics")).toBeNull();
    expect(cache.get("user-1|workouts")).toBeNull();
    expect(cache.get("user-2|analytics")).toBe(3);
  });

  it("returns 0 when no keys match", () => {
    const cache = new ServerCache<number>({ maxEntries: 16, ttlMs: 60_000 });
    cache.set("user-1|analytics", 1);
    expect(cache.deleteByPrefix("user-99|")).toBe(0);
  });
});

describe("ServerCache.wrap single-flight", () => {
  it("calls the builder once for two concurrent reads of the same key", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    let callCount = 0;
    let resolveBuilder: ((value: string) => void) | null = null;
    const builder = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          callCount += 1;
          resolveBuilder = resolve;
        }),
    );

    const first = cache.wrap("k", builder);
    const second = cache.wrap("k", builder);

    // Both reads have landed before the builder resolves.
    expect(callCount).toBe(1);
    resolveBuilder!("built");

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.value).toBe("built");
    expect(firstResult.outcome).toBe("miss");
    expect(secondResult.value).toBe("built");
    expect(secondResult.outcome).toBe("stampede");
    expect(builder).toHaveBeenCalledTimes(1);
    expect(cache.stats().stampedes).toBe(1);
  });

  it("returns the cached value as a hit on the third read", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    const builder = vi.fn(async () => "built");
    await cache.wrap("k", builder);
    const third = await cache.wrap("k", builder);
    expect(third.value).toBe("built");
    expect(third.outcome).toBe("hit");
    expect(builder).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it("clears the pending slot on builder rejection so the next call retries", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    let attempt = 0;
    const builder = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return "ok";
    });

    await expect(cache.wrap("k", builder)).rejects.toThrow("transient");
    const next = await cache.wrap("k", builder);
    expect(next.value).toBe("ok");
    expect(next.outcome).toBe("miss");
    expect(builder).toHaveBeenCalledTimes(2);
  });
});

describe("cached() observability wrapper", () => {
  it("annotates hit / miss outcome and a hashed key", async () => {
    const cache = new ServerCache<string>({
      name: "test",
      maxEntries: 4,
      ttlMs: 60_000,
    });
    const annotate = vi.fn();
    const builder = vi.fn(async () => "v");

    await cached(cache, "user-1|default", builder, annotate);
    expect(annotate).toHaveBeenCalledWith({
      meta: {
        "cache.test.outcome": "miss",
        "cache.test.key_hash": hashCacheKey("user-1|default"),
      },
    });

    annotate.mockClear();
    await cached(cache, "user-1|default", builder, annotate);
    expect(annotate).toHaveBeenCalledWith({
      meta: expect.objectContaining({
        "cache.test.outcome": "hit",
      }),
    });
  });

  it("no-ops the annotation when no annotator is passed", async () => {
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    const value = await cached(cache, "k", async () => "v");
    expect(value).toBe("v");
  });
});

describe("global cache registry", () => {
  it("exposes the eight blueprint caches as module-scope singletons", () => {
    expect(caches.analytics).toBeDefined();
    expect(caches.medications).toBeDefined();
    expect(caches.achievements).toBeDefined();
    expect(caches.dashboardWidgets).toBeDefined();
    expect(caches.bugreportStatus).toBeDefined();
    expect(caches.workouts).toBeDefined();
    expect(caches.medicationsIntake).toBeDefined();
    expect(caches.moodAnalytics).toBeDefined();
  });

  it("__resetAllCachesForTests clears every registry instance", async () => {
    await cached(caches.analytics, "user-1|default", async () => ({ ok: 1 }));
    expect(caches.analytics.stats().size).toBe(1);
    __resetAllCachesForTests();
    expect(caches.analytics.stats().size).toBe(0);
    expect(caches.analytics.stats().hits).toBe(0);
    expect(caches.analytics.stats().misses).toBe(0);
  });
});

describe("hashCacheKey", () => {
  it("is deterministic and unsigned 32-bit", () => {
    const h1 = hashCacheKey("user-1|default");
    const h2 = hashCacheKey("user-1|default");
    expect(h1).toBe(h2);
    expect(h1).toBeGreaterThanOrEqual(0);
    expect(h1).toBeLessThanOrEqual(0xffffffff);
  });

  it("distinguishes near-identical keys", () => {
    expect(hashCacheKey("user-1|default")).not.toBe(
      hashCacheKey("user-2|default"),
    );
  });
});
