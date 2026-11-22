/**
 * No server-cache entry outlives the cross-process staleness ceiling.
 *
 * The cache is process-local. With `HEALTHLOG_PROCESS_TYPE=web` beside a
 * worker, a cloud sync, a file import or a restore runs in the worker, and
 * its write tail invalidates the worker's cache only: the web process keeps
 * serving what it holds until the entry expires. A TTL is therefore the
 * longest a split deployment can show a number from before a write. The
 * resting-pulse block and the timeline's pre-fold buckets carried six hours
 * on the reasoning that "every write invalidates", which holds in one
 * process only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerCache } from "../server-cache";
import { PROCESS_CACHE_MAX_TTL_MS } from "../ttl-ceiling";

afterEach(() => {
  vi.useRealTimers();
});

describe("ServerCache TTL ceiling", () => {
  it("is fifteen minutes", () => {
    expect(PROCESS_CACHE_MAX_TTL_MS).toBe(15 * 60_000);
  });

  it("caps a per-key override at the ceiling", () => {
    vi.useFakeTimers();
    const cache = new ServerCache<string>({ maxEntries: 4, ttlMs: 60_000 });
    cache.set("k", "v", 6 * 60 * 60_000);
    vi.advanceTimersByTime(PROCESS_CACHE_MAX_TTL_MS - 1);
    expect(cache.get("k")).toBe("v");
    vi.advanceTimersByTime(2);
    expect(cache.get("k")).toBeNull();
  });

  it("refuses a bucket whose own TTL is longer", () => {
    expect(
      () =>
        new ServerCache<string>({
          maxEntries: 4,
          ttlMs: PROCESS_CACHE_MAX_TTL_MS + 1,
        }),
    ).toThrow(/ceiling/);
  });
});
