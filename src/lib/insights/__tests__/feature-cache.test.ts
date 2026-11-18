import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findFirst: vi.fn() },
  },
}));

// The user-tz day key is deterministic input to the cache key; pin it, but
// keep `resolveUserTimezone` spy-able so QA F5 (tz threading, not a
// hardcoded Berlin day) has a wiring assertion below.
const { resolveUserTimezoneMock } = vi.hoisted(() => ({
  resolveUserTimezoneMock: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: resolveUserTimezoneMock,
  userDayKey: () => "2026-06-21",
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { getCachedFeatures, withFeatureCacheScope } from "../feature-cache";

const T0 = new Date("2026-06-20T08:00:00.000Z");

/** The account's newest write, `writes` milliseconds after T0. */
function fingerprintRows(writes: number) {
  return { updatedAt: new Date(T0.getTime() + writes), id: `m${writes}` };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.measurement.findFirst).mockResolvedValue(
    fingerprintRows(10) as never,
  );
  resolveUserTimezoneMock.mockResolvedValue("Europe/Berlin");
});

describe("getCachedFeatures (P3)", () => {
  it("computes once and reuses within a scope for identical key + inputs", async () => {
    const compute = vi.fn().mockResolvedValue({ marker: "features-v1" });

    const { first, second } = await withFeatureCacheScope(async () => {
      const first = await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      const second = await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      return { first, second };
    });

    expect(compute).toHaveBeenCalledTimes(1);
    // The same object reference is handed back — a true reuse, not a re-run.
    expect(second).toBe(first);
    expect(first).toEqual({ marker: "features-v1" });
  });

  it("recomputes when the salient input fingerprint changes mid-scope", async () => {
    const compute = vi
      .fn()
      .mockResolvedValueOnce({ marker: "before" })
      .mockResolvedValueOnce({ marker: "after" });

    const out = await withFeatureCacheScope(async () => {
      const before = await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      // A new reading lands mid-scope — the fingerprint probe now sees a
      // newer write, so the gate misses and the read is recomputed.
      vi.mocked(prisma.measurement.findFirst).mockResolvedValue(
        fingerprintRows(11) as never,
      );
      const after = await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      return { before, after };
    });

    expect(compute).toHaveBeenCalledTimes(2);
    expect(out.before).toEqual({ marker: "before" });
    expect(out.after).toEqual({ marker: "after" });
  });

  it("keys separately on includeRaw and sinceDays", async () => {
    const compute = vi
      .fn()
      .mockResolvedValueOnce({ k: "agg-400" })
      .mockResolvedValueOnce({ k: "raw-400" })
      .mockResolvedValueOnce({ k: "agg-90" });

    await withFeatureCacheScope(async () => {
      await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      await getCachedFeatures({
        userId: "u1",
        includeRaw: true,
        sinceDays: 400,
        compute,
      });
      await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 90,
        compute,
      });
    });

    // Three distinct keys → three computes (no cross-key collision).
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("keys separately per user (no cross-user leak)", async () => {
    const compute = vi
      .fn()
      .mockResolvedValueOnce({ u: "u1" })
      .mockResolvedValueOnce({ u: "u2" });

    const out = await withFeatureCacheScope(async () => {
      const a = await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      const b = await getCachedFeatures({
        userId: "u2",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      return { a, b };
    });

    expect(compute).toHaveBeenCalledTimes(2);
    expect(out.a).toEqual({ u: "u1" });
    expect(out.b).toEqual({ u: "u2" });
  });

  it("passes straight through (no caching, no probe) outside any scope", async () => {
    const compute = vi.fn().mockResolvedValue({ marker: "x" });

    const a = await getCachedFeatures({
      userId: "u1",
      includeRaw: false,
      sinceDays: 400,
      compute,
    });
    const b = await getCachedFeatures({
      userId: "u1",
      includeRaw: false,
      sinceDays: 400,
      compute,
    });

    // No scope → no memoisation → each call computes; and the fingerprint
    // probe is never even issued (it only runs inside a scope).
    expect(compute).toHaveBeenCalledTimes(2);
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
    expect(a).toEqual({ marker: "x" });
    expect(b).toEqual({ marker: "x" });
  });

  it("does not share a cache across sibling scopes", async () => {
    const compute = vi.fn().mockResolvedValue({ marker: "y" });

    await withFeatureCacheScope(() =>
      getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      }),
    );
    await withFeatureCacheScope(() =>
      getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      }),
    );

    // Each scope has its own store, so the second scope recomputes.
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("resolves the day-key in the CALLING USER's own tz, not a hardcoded Berlin (QA F5)", async () => {
    const compute = vi.fn().mockResolvedValue({ marker: "z" });

    await withFeatureCacheScope(() =>
      getCachedFeatures({
        userId: "u-ny",
        includeRaw: false,
        sinceDays: 400,
        compute,
      }),
    );

    expect(resolveUserTimezoneMock).toHaveBeenCalledWith("u-ny");
  });

  it("recomputes on a fingerprint probe failure rather than serving a stale object", async () => {
    const compute = vi
      .fn()
      .mockResolvedValueOnce({ marker: "1" })
      .mockResolvedValueOnce({ marker: "2" });
    vi.mocked(prisma.measurement.findFirst).mockRejectedValue(
      new Error("db down"),
    );

    const out = await withFeatureCacheScope(async () => {
      const first = await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      const second = await getCachedFeatures({
        userId: "u1",
        includeRaw: false,
        sinceDays: 400,
        compute,
      });
      return { first, second };
    });

    // A failed probe yields a unique sentinel hash each call → the key never
    // matches → the read is recomputed (fail-safe, never a wrong reuse).
    expect(compute).toHaveBeenCalledTimes(2);
    expect(out.first).toEqual({ marker: "1" });
    expect(out.second).toEqual({ marker: "2" });
  });
});
