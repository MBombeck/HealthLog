/**
 * The memory bound of the server cache: every bucket without its own weight
 * is held to a byte budget, a share of the heap limit, and an entry nobody
 * reads again is dropped once it can no longer be served.
 *
 * Both were missing. The buckets counted entries only, and an entry can be a
 * layout of a few hundred bytes or a closed window of dense readings of
 * several megabytes; a key that was never read again stayed until the entry
 * cap pushed it out, which for a quiet bucket meant for the life of the
 * process.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approxBytes,
  bucketByteBudget,
  CACHE_BUCKET_SHARES,
  CACHE_HEAP_SHARE,
  DEFAULT_BUCKET_SHARE,
} from "../approx-bytes";
import { __resetAllCachesForTests, caches, ServerCache } from "../server-cache";

afterEach(() => {
  __resetAllCachesForTests();
  vi.useRealTimers();
});

/** Dense readings as the closed-window blocks hold them. */
function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${i}`,
    value: 60 + (i % 30),
    measuredAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
    source: "APPLE_HEALTH",
  }));
}

describe("approxBytes", () => {
  it("weighs a large value large and a small one small", () => {
    const small = approxBytes({ layout: ["a", "b"] });
    const large = approxBytes(rows(100_000));
    expect(small).toBeLessThan(1_000);
    // A row is four slots, a short string, a date and a number: well over
    // 50 bytes each, so 100 000 of them weigh several megabytes.
    expect(large).toBeGreaterThan(5_000_000);
  });

  it("scales with the length of a long array without walking it", () => {
    const ten = approxBytes(rows(10_000));
    const hundred = approxBytes(rows(100_000));
    expect(hundred / ten).toBeGreaterThan(8);
    expect(hundred / ten).toBeLessThan(12);
  });

  it("stops at its visit budget on a deep value and survives a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(approxBytes(cyclic)).toBeGreaterThan(0);
    let deep: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) deep = { next: deep, i };
    expect(Number.isFinite(approxBytes(deep))).toBe(true);
  });
});

describe("the byte budget", () => {
  it("evicts from the least-recently-used end until the bytes fit", () => {
    const cache = new ServerCache<unknown>({
      name: "budget-probe",
      maxEntries: 1000,
      ttlMs: 60_000,
    });
    const budget = bucketByteBudget("budget-probe");
    const one = approxBytes(rows(20_000));
    const fits = Math.floor(budget / one);
    expect(fits).toBeGreaterThan(0);
    for (let i = 0; i < fits + 3; i++) cache.set(`k${i}`, rows(20_000));
    // Far under the entry cap, yet the oldest entries are gone.
    expect(cache.stats().size).toBeLessThanOrEqual(fits);
    expect(cache.get("k0")).toBeNull();
    expect(cache.get(`k${fits + 2}`)).not.toBeNull();
  });

  it("keeps no value larger than the whole budget", () => {
    const cache = new ServerCache<unknown>({
      name: "budget-probe",
      maxEntries: 10,
      ttlMs: 60_000,
    });
    const tooBig = Math.ceil(bucketByteBudget("budget-probe") / 40) + 10;
    cache.set("huge", rows(tooBig));
    expect(cache.get("huge")).toBeNull();
  });

  it("gives every registry bucket a byte budget inside the cache share", () => {
    const heap = 524 * 1024 * 1024;
    let total = 0;
    for (const cache of Object.values(caches)) {
      const name = cache.stats().name;
      // The workouts bucket weighs rows, not bytes (its own `maxWeight`).
      if (name === "workouts") continue;
      total += bucketByteBudget(name, heap);
    }
    expect(total).toBeLessThanOrEqual(heap * CACHE_HEAP_SHARE);
    // Every named share belongs to a bucket that exists.
    const names = new Set(Object.values(caches).map((c) => c.stats().name));
    for (const name of Object.keys(CACHE_BUCKET_SHARES)) {
      expect(names.has(name)).toBe(true);
    }
    expect(DEFAULT_BUCKET_SHARE).toBeGreaterThan(0);
  });
});

describe("the dead-entry sweep", () => {
  it("drops entries past their stale window on the next write a minute on", () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({
      name: "sweep-probe",
      maxEntries: 100,
      ttlMs: 1_000,
      staleTtlMs: 1_000,
    });
    for (let i = 0; i < 10; i++) cache.set(`dead${i}`, "x");
    vi.advanceTimersByTime(61_000);
    cache.set("live", "y");
    // Nothing read the ten again; the write swept them.
    expect(cache.stats().size).toBe(1);
  });

  it("keeps an entry that can still be served stale", () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({
      name: "sweep-probe",
      maxEntries: 100,
      ttlMs: 1_000,
      staleTtlMs: 120_000,
    });
    cache.set("stale-but-servable", "x");
    vi.advanceTimersByTime(61_000);
    cache.set("other", "y");
    expect(cache.getAllowStale("stale-but-servable")?.stale).toBe(true);
  });
});
