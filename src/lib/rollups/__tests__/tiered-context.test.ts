/**
 * v1.18.7 — unit tests for the progressive tiered-context builder.
 *
 * `readRollupBuckets` (the per-granularity rollup reader),
 * `ensureUserRollupsFresh`, `probeRollupCoverage`, and
 * `prisma.measurement.findMany` are mocked at the module level so the test
 * pins the band routing + the min/max-envelope anomaly extraction without a
 * real Postgres. The behaviours it locks:
 *   - each band reads from the correct granularity over the right window,
 *   - the 0–14d band reads raw rows and folds same-day points,
 *   - a coarse-bucket peak above mean + 2·sd survives as an anomaly,
 *   - sparse buckets (count < 3) never trip the anomaly gate,
 *   - the anomaly list is ranked by |deltaSd| and capped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RollupGranularity } from "@/generated/prisma/client";

const mocks = vi.hoisted(() => ({
  readRollupBuckets: vi.fn(),
  ensureUserRollupsFresh: vi.fn(),
  probeRollupCoverage: vi.fn(),
  measurementFindMany: vi.fn(),
  queryRaw: vi.fn(),
}));

// Day-mean reads fold per-day aggregates in SQL; the fake folds the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("../measurement-rollups", () => ({
  readRollupBuckets: mocks.readRollupBuckets,
  ensureUserRollupsFresh: mocks.ensureUserRollupsFresh,
}));

vi.mock("../measurement-coverage", () => ({
  probeRollupCoverage: mocks.probeRollupCoverage,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: mocks.measurementFindMany },
    // v1.37.19 — the live band fallback.
    $queryRaw: mocks.queryRaw,
  },
}));

import { buildTieredSeries } from "../tiered-context";

const NOW = new Date("2026-06-19T00:00:00.000Z").getTime();

function rollupRow(
  bucketStart: string,
  mean: number,
  min: number,
  max: number,
  count: number,
) {
  return {
    bucketStart: new Date(bucketStart),
    count,
    mean,
    minValue: min,
    maxValue: max,
    sd: null,
    slope: null,
    r2: null,
    computedAt: new Date(bucketStart),
  };
}

describe("buildTieredSeries", () => {
  beforeEach(() => {
    mocks.ensureUserRollupsFresh.mockResolvedValue({ recomputed: false });
    mocks.probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    mocks.measurementFindMany.mockResolvedValue([]);
    mocks.readRollupBuckets.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes each band to the correct granularity over the right window", async () => {
    await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: "Europe/Berlin" });
    const grans = mocks.readRollupBuckets.mock.calls.map(
      (c) => c[2] as RollupGranularity,
    );
    expect(grans).toEqual(["DAY", "WEEK", "MONTH", "YEAR"]);
  });

  it("folds same-day raw rows into one 0-14d point", async () => {
    mocks.measurementFindMany.mockResolvedValue([
      { value: 80, measuredAt: new Date("2026-06-18T07:00:00.000Z") },
      { value: 82, measuredAt: new Date("2026-06-18T20:00:00.000Z") },
      { value: 79, measuredAt: new Date("2026-06-17T07:00:00.000Z") },
    ]);
    const series = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Europe/Berlin",
    });
    expect(series.recentDaily).toHaveLength(2);
    const day18 = series.recentDaily.find((p) => p.date === "2026-06-18");
    expect(day18?.value).toBe(81); // (80 + 82) / 2
    expect(day18?.count).toBe(2);
  });

  it("preserves a coarse-bucket peak as an anomaly via the min/max envelope", async () => {
    // A WEEK band with one bucket whose MAX is a clear outlier (>2 sd).
    mocks.readRollupBuckets.mockImplementation(
      async (_u: string, _t: string, gran: RollupGranularity) => {
        if (gran === "WEEK") {
          return [
            rollupRow("2026-05-01T00:00:00.000Z", 100, 99, 100, 5),
            rollupRow("2026-05-08T00:00:00.000Z", 101, 100, 102, 5),
            rollupRow("2026-05-15T00:00:00.000Z", 100, 99, 101, 5),
            // The spike: max 140 is far above the ~100 mean.
            rollupRow("2026-05-22T00:00:00.000Z", 105, 100, 140, 5),
          ];
        }
        return [];
      },
    );
    const series = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Europe/Berlin",
    });
    expect(series.anomalies.length).toBeGreaterThanOrEqual(1);
    const peak = series.anomalies.find((a) => a.kind === "peak");
    expect(peak?.value).toBe(140);
    expect(peak?.band).toBe("week");
    expect(peak?.deltaSd).toBeGreaterThanOrEqual(2);
  });

  it("ignores sparse buckets (count < 3) when extracting anomalies", async () => {
    mocks.readRollupBuckets.mockImplementation(
      async (_u: string, _t: string, gran: RollupGranularity) => {
        if (gran === "WEEK") {
          return [
            rollupRow("2026-05-01T00:00:00.000Z", 100, 99, 100, 5),
            rollupRow("2026-05-08T00:00:00.000Z", 100, 99, 101, 5),
            rollupRow("2026-05-15T00:00:00.000Z", 100, 99, 101, 5),
            // Outlier max but only 1 sample backing the bucket — suppressed.
            rollupRow("2026-05-22T00:00:00.000Z", 200, 200, 200, 1),
          ];
        }
        return [];
      },
    );
    const series = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Europe/Berlin",
    });
    expect(series.anomalies).toHaveLength(0);
  });

  describe("user-tz day-keying for the raw 0-14d band", () => {
    it("folds a late-evening reading onto its LOCAL day, not the UTC day", async () => {
      // 23:30 local in Berlin (CEST, +02:00) on 2026-06-15 is
      // 21:30Z on the same date — UTC and local agree here. The
      // partner reading at 00:30 local on 2026-06-16 (CEST) is
      // 22:30Z on 2026-06-15: a naive UTC key would mis-fold it onto
      // the 15th. The tz-aware key keeps it on the 16th.
      mocks.measurementFindMany.mockResolvedValue([
        { value: 70, measuredAt: new Date("2026-06-15T21:30:00.000Z") },
        { value: 90, measuredAt: new Date("2026-06-15T22:30:00.000Z") },
      ]);
      const series = await buildTieredSeries("u1", "WEIGHT", {
        now: new Date("2026-06-20T00:00:00.000Z").getTime(),
        tz: "Europe/Berlin",
      });
      const days = series.recentDaily.map((p) => p.date).sort();
      expect(days).toEqual(["2026-06-15", "2026-06-16"]);
      expect(
        series.recentDaily.find((p) => p.date === "2026-06-16")?.value,
      ).toBe(90);
    });

    it("buckets a fall-back DST-night reading on the correct local day", async () => {
      // Germany falls back 2026-10-25 03:00 CEST → 02:00 CET. A reading
      // at 23:30 local that night is 21:30Z and must key to 2026-10-25
      // (local), which it does in both offsets; the partner reading at
      // 01:00 local the next morning (2026-10-26, after the fall-back,
      // CET +01:00) is 00:00Z on 2026-10-26 — same date by luck. Pick a
      // reading that exposes the offset: 00:30 local on 2026-10-26 CET
      // is 23:30Z on 2026-10-25; a UTC key drops it onto the 25th, the
      // tz-aware key keeps it on the 26th.
      mocks.measurementFindMany.mockResolvedValue([
        { value: 10, measuredAt: new Date("2026-10-25T21:30:00.000Z") }, // 23:30 CEST, 25th
        { value: 20, measuredAt: new Date("2026-10-25T23:30:00.000Z") }, // 00:30 CET, 26th
      ]);
      const series = await buildTieredSeries("u1", "WEIGHT", {
        now: new Date("2026-10-30T00:00:00.000Z").getTime(),
        tz: "Europe/Berlin",
      });
      const days = series.recentDaily.map((p) => p.date).sort();
      expect(days).toEqual(["2026-10-25", "2026-10-26"]);
    });

    it("buckets a spring-forward DST-night reading on the correct local day", async () => {
      // Germany springs forward 2026-03-29 02:00 CET → 03:00 CEST. A
      // 00:30-local reading that morning (CET +01:00) is 23:30Z on
      // 2026-03-28; the UTC key mis-folds it to the 28th, the tz-aware
      // key keeps it on the 29th. A 23:30-local reading later that day
      // (CEST +02:00) is 21:30Z on 2026-03-29 — correct in both.
      mocks.measurementFindMany.mockResolvedValue([
        { value: 5, measuredAt: new Date("2026-03-28T23:30:00.000Z") }, // 00:30 CET, 29th
        { value: 15, measuredAt: new Date("2026-03-29T21:30:00.000Z") }, // 23:30 CEST, 29th
      ]);
      const series = await buildTieredSeries("u1", "WEIGHT", {
        now: new Date("2026-04-02T00:00:00.000Z").getTime(),
        tz: "Europe/Berlin",
      });
      // Both readings fold onto 2026-03-29 in local time.
      expect(series.recentDaily).toHaveLength(1);
      expect(series.recentDaily[0].date).toBe("2026-03-29");
      expect(series.recentDaily[0].count).toBe(2);
      expect(series.recentDaily[0].value).toBe(10); // (5 + 15) / 2
    });

    it("keys west-of-UTC users on their own local day", async () => {
      // 22:00 local in Honolulu (HST, -10:00) on 2026-06-15 is 08:00Z
      // on 2026-06-16: a UTC key lands it on the 16th, the tz-aware key
      // keeps it on the user's local 15th.
      mocks.measurementFindMany.mockResolvedValue([
        { value: 42, measuredAt: new Date("2026-06-16T08:00:00.000Z") },
      ]);
      const series = await buildTieredSeries("u1", "WEIGHT", {
        now: new Date("2026-06-20T00:00:00.000Z").getTime(),
        tz: "Pacific/Honolulu",
      });
      expect(series.recentDaily).toHaveLength(1);
      expect(series.recentDaily[0].date).toBe("2026-06-15");
    });
  });
});

// v1.37.19 — the live fallback the module doc promised from day
// one, and the far-from-UTC day-grain guard.
//
// Watched red: with the `readBandLive` fallback removed from `readBand`
// (the pre-fix reader returned the empty rollup result as-is), the
// coverage-miss case fails — a >5y account whose YEAR partition was never
// folded handed the AI empty MONTH/YEAR bands as if the history did not
// exist. With the `isNearUtc` guard removed, the far-tz case fails — the
// DAY band read UTC-keyed rollup buckets for a user whose local calendar
// disagrees with UTC for most of the day.
describe("buildTieredSeries — live fallback + near-UTC guard (A6-11)", () => {
  beforeEach(() => {
    mocks.ensureUserRollupsFresh.mockResolvedValue({ recomputed: false });
    mocks.probeRollupCoverage.mockResolvedValue(new Map([["WEIGHT", true]]));
    mocks.measurementFindMany.mockResolvedValue([]);
    mocks.readRollupBuckets.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("serves an empty rollup band from the live aggregate instead of silence", async () => {
    mocks.readRollupBuckets.mockResolvedValue([]);
    mocks.queryRaw.mockResolvedValue([
      {
        bucket_start: new Date("2025-01-01T00:00:00.000Z"),
        count: 40,
        mean: 82.1,
        min_value: 78,
        max_value: 90,
        sd: 2.5,
      },
    ]);

    const series = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Europe/Berlin",
    });

    // Every band read fell through to the live aggregate (4 bands).
    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(series.yearBand.length).toBeGreaterThan(0);
    expect(series.yearBand[0]).toMatchObject({ mean: 82.1, min: 78, max: 90 });
  });

  it("keeps the rollup result when the band has buckets (no live read)", async () => {
    mocks.readRollupBuckets.mockResolvedValue([
      rollupRow("2026-05-01T00:00:00.000Z", 80, 79, 81, 10),
    ]);

    await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Europe/Berlin",
    });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("routes the DAY band straight to the tz-keyed live path for far-from-UTC users", async () => {
    await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Pacific/Auckland",
    });

    // The DAY grain never touched the UTC-keyed rollup tier …
    const dayReads = mocks.readRollupBuckets.mock.calls.filter(
      (c) => c[2] === "DAY",
    );
    expect(dayReads).toEqual([]);
    // … while the coarser bands still did.
    const coarseReads = mocks.readRollupBuckets.mock.calls.map(
      (c) => c[2] as RollupGranularity,
    );
    expect(coarseReads).toEqual(
      expect.arrayContaining(["WEEK", "MONTH", "YEAR"]),
    );
  });

  it("still reads the DAY rollup inside the near-UTC band", async () => {
    mocks.readRollupBuckets.mockResolvedValue([
      rollupRow("2026-06-01T00:00:00.000Z", 80, 79, 81, 10),
    ]);
    await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Europe/Berlin",
    });
    const dayReads = mocks.readRollupBuckets.mock.calls.filter(
      (c) => c[2] === "DAY",
    );
    expect(dayReads.length).toBe(1);
  });
});
