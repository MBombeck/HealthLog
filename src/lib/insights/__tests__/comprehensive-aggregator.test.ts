/**
 * Unit pin for `buildComprehensiveAggregate`.
 *
 * Heavier integration coverage (real Postgres, real `regr_slope`,
 * cache hit/miss assertions, byte-identical parity with live SQL)
 * lives in `tests/integration/insights-comprehensive-cache.test.ts`
 * and `tests/integration/measurement-rollups.test.ts`. This file
 * mocks `$queryRaw` and Prisma's `measurement.findMany` so the shape
 * + rounding + slope-direction + read-path-selection contracts are
 * pinned without a container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    // v1.11.1 — the data-aggregate queries inside `buildFromRollups`
    // and `buildFromLiveAggregate` now splice a whitelisted source-rank
    // CASE and bind `userId` as `$1`, so the narrow/heavy aggregate +
    // the latests pass run via `$queryRawUnsafe(sql, userId)` rather
    // than the tagged-template `$queryRaw`. The coverage probe and the
    // first_at query stay on `$queryRaw`.
    $queryRawUnsafe: vi.fn(),
    // v1.11.1 — `loadUserSourcePriority` reads the user's
    // `sourcePriorityJson` to build the rank ladders. `null` here →
    // default ladders.
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn(), findFirst: vi.fn() },
    // v1.4.36 — the rollup read inside the Promise.all + the
    // freshness watermark inside `ensureUserRollupsFresh`. We mock
    // both so the unit test doesn't need a real container.
    measurementRollup: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

// v1.11.1 — `buildFromRollups` / `buildFromLiveAggregate` build a
// source-rank CASE via `@/lib/analytics/source-rank-sql` and splice it
// into the data-aggregate SQL. The builder's own correctness is pinned
// in its dedicated suite (and the integration suite runs the real SQL);
// here we stub it to deterministic, side-effect-free fragments so the
// aggregator's plumbing — path selection, bpRaw threading, dailyByType
// composition — is exercised without coupling the unit test to the rank
// builder's enum-whitelist internals.
vi.mock("@/lib/analytics/source-rank-sql", () => {
  const cte = (_rank: string, sinceInterval?: string) =>
    `
        SELECT mm.*
        FROM measurements mm
        WHERE mm."user_id" = $1
          AND mm."deleted_at" IS NULL
          ${
            sinceInterval
              ? `AND mm."measured_at" >= NOW() - INTERVAL '${sinceInterval}'`
              : ""
          }`;
  return {
    buildSourceRankCase: vi.fn(() => "90"),
    // v1.18.11 perf#3a — the aggregator now folds the canonical-source
    // self-join into a single `WITH cm AS (…)` CTE referenced twice, so the
    // unit mock must expose both the CTE body and the alias-wrapped form.
    canonicalMeasurementsCte: vi.fn(cte),
    canonicalMeasurementsFrom: vi.fn(
      (rank: string, sinceInterval?: string) => `(${cte(rank, sinceInterval)}
      ) m`,
    ),
  };
});

import { prisma } from "@/lib/db";
import { buildComprehensiveAggregate } from "../comprehensive-aggregator";
import {
  composeWindowedRegression,
  type AccumulatorBucketRow,
} from "@/lib/rollups/measurement-read";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";

const RAW = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const UNSAFE = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
const USER_FIND_UNIQUE = prisma.user.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const FIND_MANY = prisma.measurement.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const MEASUREMENT_FIND_FIRST = prisma.measurement
  .findFirst as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup
  .findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_FIRST = prisma.measurementRollup
  .findFirst as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  RAW.mockReset();
  UNSAFE.mockReset();
  USER_FIND_UNIQUE.mockReset();
  FIND_MANY.mockReset();
  MEASUREMENT_FIND_FIRST.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  ROLLUP_FIND_FIRST.mockReset();
  // null → loadUserSourcePriority returns null → default rank ladders.
  USER_FIND_UNIQUE.mockResolvedValue(null);
  // `ensureUserRollupsFresh` calls `prisma.measurement.findFirst` and
  // `prisma.measurementRollup.findFirst` in parallel. Default both to
  // null so the warm-up is a no-op; individual tests opt in to a
  // freshness mismatch by overriding the mocks.
  ROLLUP_FIND_MANY.mockResolvedValue([]);
  ROLLUP_FIND_FIRST.mockResolvedValue(null);
  MEASUREMENT_FIND_FIRST.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildComprehensiveAggregate", () => {
  describe("rollup-fresh happy path", () => {
    it("skips the heavy live aggregate when the rollup table is populated", async () => {
      const now = new Date();
      // v1.11.1 — the coverage probe + the first_at query stay on
      // `$queryRaw` (2 RAW calls); the narrow aggregate + the latests
      // pass moved to `$queryRawUnsafe`:
      // RAW:    1. per-type coverage probe — WEIGHT covered ⇒ happy path.
      //         2. firstMeasurementAt.
      // UNSAFE: 1. narrow aggregate — windowed/regression columns only.
      //         2. latests.
      RAW.mockResolvedValueOnce([
        { type: "WEIGHT", has_buckets: true },
      ]).mockResolvedValueOnce([
        { first_at: new Date(now.getTime() - 86400000) },
      ]);
      UNSAFE.mockResolvedValueOnce([
        {
          type: "WEIGHT",
          count: BigInt(42),
          stddev_value: 1.2,
          anomaly_count: BigInt(3),
          avg7: 81.9,
          avg30: 82.1,
          avg30_last_month: 83.0,
          // v1.20.0 — slope / r² no longer ride the narrow aggregate;
          // they compose from the accumulator buckets below.
        },
      ]).mockResolvedValueOnce([
        { type: "WEIGHT", value: 81.4, measured_at: now },
      ]);

      // DAY buckets compose to count=42, min=79.2, max=84.1, mean=82.05.
      // The summary's count/min/max/mean read from these buckets — NOT
      // from a heavy live aggregate column. v1.11.1 — each bucket row
      // now carries a `source` so `partitionBucketsByType` →
      // `collapseRollupRowsBySource` can resolve dual-source days; with
      // a single source per day every bucket passes through unchanged.
      //
      // v1.20.0 — buckets are placed on recent UTC days so they fall
      // inside the 7-day slope window, and carry the regression
      // accumulators the windowed slope / r² compose from. Each bucket
      // models its `count` readings as all landing at the bucket's day
      // midnight (x = bucketStart epoch-day) with value = mean, which is a
      // valid, self-consistent accumulator set. The 81-mean readings are
      // split over two days (5 and 3 days ago) so the window holds three
      // days spanning five: enough evidence for a trend.
      const dayB = startOfUtcDay(now);
      const dayA = startOfUtcDay(new Date(now.getTime() - 5 * 86_400_000));
      const dayA2 = startOfUtcDay(new Date(now.getTime() - 3 * 86_400_000));
      const xA = dayA.getTime() / 86_400_000;
      const xA2 = dayA2.getTime() / 86_400_000;
      const xB = dayB.getTime() / 86_400_000;
      const bucketA = {
        type: "WEIGHT",
        source: "APPLE_HEALTH",
        bucketStart: dayA,
        count: 10,
        mean: 81.0,
        minValue: 79.2,
        maxValue: 82.5,
        sumX: 10 * xA,
        sumXy: 10 * xA * 81.0,
        sumXx: 10 * xA * xA,
        sumYy: 10 * 81.0 * 81.0,
      };
      const bucketA2 = {
        type: "WEIGHT",
        source: "APPLE_HEALTH",
        bucketStart: dayA2,
        count: 10,
        mean: 81.0,
        minValue: 79.2,
        maxValue: 82.5,
        sumX: 10 * xA2,
        sumXy: 10 * xA2 * 81.0,
        sumXx: 10 * xA2 * xA2,
        sumYy: 10 * 81.0 * 81.0,
      };
      const bucketB = {
        type: "WEIGHT",
        source: "APPLE_HEALTH",
        bucketStart: dayB,
        count: 22,
        mean: 83.0,
        minValue: 80.0,
        maxValue: 84.1,
        sumX: 22 * xB,
        sumXy: 22 * xB * 83.0,
        sumXx: 22 * xB * xB,
        sumYy: 22 * 83.0 * 83.0,
      };
      ROLLUP_FIND_MANY.mockResolvedValueOnce([bucketA, bucketA2, bucketB]);
      // Expected slope7 — composed from the same accumulators the reader
      // sees (the buildSlope contract rounds slope to 3 dp, confidence to
      // 2 dp). Computed here from composeWindowedRegression so the test
      // tracks the closed form rather than a hand-typed magic number.
      const accBuckets: AccumulatorBucketRow[] = [
        bucketA,
        bucketA2,
        bucketB,
      ].map((b) => ({
        bucketStart: b.bucketStart,
        count: b.count,
        mean: b.mean,
        sumX: b.sumX,
        sumXy: b.sumXy,
        sumXx: b.sumXx,
        sumYy: b.sumYy,
      }));
      const since7 = startOfUtcDay(new Date(Date.now() - 7 * 86_400_000));
      const expectedReg7 = composeWindowedRegression(accBuckets, since7);

      // v1.18.10 — bpRawRows now reads source-collapsed rows via
      // `$queryRawUnsafe` (3rd UNSAFE call: narrow, latests, bpRaw). Empty
      // here since the rollup-fresh fixture doesn't exercise BP pairing.
      UNSAFE.mockResolvedValueOnce([]);

      const result = await buildComprehensiveAggregate("user-rollup-fresh");
      const weight = result.summaries.WEIGHT;

      // count/min/max/mean composed from buckets — the test asserts the
      // bucket-derived values are present even though we never wired up
      expect(weight.count).toBe(42);
      expect(weight.min).toBe(79.2);
      expect(weight.max).toBe(84.1);
      // Weighted mean = (20 * 81 + 22 * 83) / 42 = 3446 / 42 ≈ 82.0476
      // → round2 → 82.05.
      expect(weight.mean).toBe(82.05);
      // Windowed/regression columns come from the narrow aggregate.
      expect(weight.latest).toBe(81.4);
      expect(weight.avg7).toBe(81.9);
      expect(weight.avg30).toBe(82.1);
      expect(weight.avg30LastMonth).toBe(83.0);
      expect(weight.anomalyCount).toBe(3);
      // v1.20.0 — slope7 composes from the accumulator buckets. The
      // recent buckets (means 81, 81 → 83 over five days) yield a positive
      // slope; assert against the closed form the reader uses.
      expect(expectedReg7.slope).not.toBeNull();
      expect(weight.slope7).toEqual({
        slope: Math.round((expectedReg7.slope as number) * 1000) / 1000,
        direction: "up",
        confidence:
          expectedReg7.r2 === null
            ? 0
            : Math.round(expectedReg7.r2 * 100) / 100,
      });
      expect(result.dailyByType.WEIGHT).toEqual([
        { day: dayA.toISOString().slice(0, 10), value: 81 },
        { day: dayA2.toISOString().slice(0, 10), value: 81 },
        { day: dayB.toISOString().slice(0, 10), value: 83 },
      ]);

      // Contract pin — the heavy aggregate path is NOT exercised on the
      // rollup-fresh branch. v1.11.1 — the coverage probe + first_at
      // stay on `$queryRaw` (2 calls); the narrow aggregate + the
      // DISTINCT-ON latest moved to `$queryRawUnsafe` (2 calls). Neither
      // path runs the legacy heavy COUNT/MIN/MAX/AVG query.
      expect(RAW).toHaveBeenCalledTimes(2);
      // v1.18.10 — narrow + latests + bpRaw all run on `$queryRawUnsafe`.
      expect(UNSAFE).toHaveBeenCalledTimes(3);
      // bpRawRows no longer uses `measurement.findMany`.
      expect(FIND_MANY).not.toHaveBeenCalled();
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(1);
    });
  });

  describe("cold fallback when no rollup buckets exist", () => {
    it("returns an empty bundle for a user with no measurements and no rollups", async () => {
      // v1.11.1 — the coverage probe stays on `$queryRaw`; the heavy
      // aggregate + latests moved to `$queryRawUnsafe`:
      // RAW:    1. per-type coverage probe — empty ⇒ cold path.
      // UNSAFE: 1. heavy aggregate — empty.
      //         2. latests — empty.
      // No firstMeasurementAt query when totalMeasurements === 0.
      RAW.mockResolvedValueOnce([]);
      // heavy, latests, bpRaw — all empty.
      UNSAFE.mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await buildComprehensiveAggregate("user-empty");

      expect(result.summaries).toEqual({});
      expect(result.bpRawRows.sys).toEqual([]);
      expect(result.bpRawRows.dia).toEqual([]);
      expect(result.dailyByType).toEqual({});
      expect(result.firstMeasurementAt).toBeNull();
      expect(result.totalMeasurements).toBe(0);
      expect(RAW).toHaveBeenCalledTimes(1);
      // v1.18.10 — heavy + latests + bpRaw all on `$queryRawUnsafe`.
      expect(UNSAFE).toHaveBeenCalledTimes(3);
      expect(FIND_MANY).not.toHaveBeenCalled();
      // The cold path's rollup.findMany still fires (in case some
      // buckets exist for a subset of types post-race), but returns [].
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(1);
    });

    it("runs the heavy aggregate when no rollup rows exist yet", async () => {
      const now = new Date();
      // v1.11.1 — the coverage probe + first_at stay on `$queryRaw`; the
      // heavy aggregate + latests moved to `$queryRawUnsafe`:
      // RAW:    1. per-type coverage probe — WEIGHT measured but no
      //            buckets ⇒ cold path.
      //         2. firstMeasurementAt (totalMeasurements > 0).
      // UNSAFE: 1. heavy aggregate — populated.
      //         2. latests — populated.
      RAW.mockResolvedValueOnce([
        { type: "WEIGHT", has_buckets: false },
      ]).mockResolvedValueOnce([
        { first_at: new Date(now.getTime() - 86400000) },
      ]);
      UNSAFE.mockResolvedValueOnce([
        {
          type: "WEIGHT",
          count: BigInt(42),
          min_value: 79.2,
          max_value: 84.1,
          mean_value: 82.05,
          stddev_value: 1.2,
          anomaly_count: BigInt(3),
          avg7: 81.9,
          avg30: 82.1,
          avg30_last_month: 83.0,
          slope7: -0.014,
          r2_7: 0.65,
          slope30: -0.005,
          r2_30: 0.42,
          // Readings on enough days, spread far enough, for both windows.
          days7: 6,
          span7: 6,
          days30: 20,
          span30: 29,
        },
      ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 81.4, measured_at: now },
        ])
        // v1.18.10 — bpRaw (empty) is the 3rd UNSAFE call.
        .mockResolvedValueOnce([]);

      const result = await buildComprehensiveAggregate("user-cold");
      const weight = result.summaries.WEIGHT;

      expect(weight.count).toBe(42);
      expect(weight.latest).toBe(81.4);
      expect(weight.min).toBe(79.2);
      expect(weight.max).toBe(84.1);
      expect(weight.mean).toBe(82.05);
      expect(weight.avg7).toBe(81.9);
      expect(weight.avg30).toBe(82.1);
      expect(weight.avg30LastMonth).toBe(83.0);
      expect(weight.avg30LastYear).toBeNull();
      expect(weight.anomalyCount).toBe(3);
      expect(weight.slope7).toEqual({
        slope: -0.014,
        direction: "down",
        confidence: 0.65,
      });
      expect(weight.slope30).toEqual({
        slope: -0.005,
        direction: "stable",
        confidence: 0.42,
      });

      expect(result.totalMeasurements).toBe(42);
      expect(result.firstMeasurementAt).toBeInstanceOf(Date);
      // The cold path's `dailyByType` is sourced from the same rollup
      // findMany call (returns [] here since no buckets exist). The
      // contract is: even on cold mount, if buckets do exist for some
      // type, they feed `dailyByType` so the v1.4.35 shape is stable.
      expect(result.dailyByType.WEIGHT).toBeUndefined();
    });

    it("withholds a slope whose window readings cover too few days", async () => {
      const now = new Date();
      RAW.mockResolvedValueOnce([
        { type: "BLOOD_PRESSURE_SYS", has_buckets: false },
      ]).mockResolvedValueOnce([{ first_at: now }]);
      const queries: string[] = [];
      UNSAFE.mockImplementationOnce((sql: string) => {
        queries.push(sql);
        return Promise.resolve([
          {
            type: "BLOOD_PRESSURE_SYS",
            count: BigInt(3),
            min_value: 118,
            max_value: 130,
            mean_value: 124,
            stddev_value: 6,
            anomaly_count: BigInt(0),
            avg7: 124,
            avg30: 124,
            avg30_last_month: null,
            // REGR_SLOPE over three readings minutes apart, one day.
            slope7: -2160,
            r2_7: 1,
            slope30: -2160,
            r2_30: 1,
            days7: 1,
            span7: 0,
            days30: 1,
            span30: 0,
          },
        ]);
      })
        .mockResolvedValueOnce([
          { type: "BLOOD_PRESSURE_SYS", value: 124, measured_at: now },
        ])
        .mockResolvedValueOnce([]);

      const result = await buildComprehensiveAggregate("user-cluster");
      const sys = result.summaries.BLOOD_PRESSURE_SYS;
      expect(sys.avg7).toBe(124);
      expect(sys.slope7).toBeNull();
      expect(sys.slope30).toBeNull();
      // The evidence is read by the same aggregate that fits the slope.
      expect(queries[0]).toContain("AS days7");
      expect(queries[0]).toContain("AS span30");
    });
  });

  it("threads sys/dia raw rows through bpRawRows so 5-min pairing survives", async () => {
    const measuredAt = new Date("2026-05-10T08:00:00Z");
    // Cold path so the heavy aggregate fires (BP type lacks coverage).
    // v1.11.1 — coverage probe + first_at on `$queryRaw`; heavy + latests
    // on `$queryRawUnsafe`.
    RAW.mockResolvedValueOnce([
      { type: "BLOOD_PRESSURE_SYS", has_buckets: false },
    ]).mockResolvedValueOnce([{ first_at: measuredAt }]);
    UNSAFE.mockResolvedValueOnce([
      {
        type: "BLOOD_PRESSURE_SYS",
        count: BigInt(1),
        min_value: 120,
        max_value: 120,
        mean_value: 120,
        stddev_value: 0,
        anomaly_count: BigInt(0),
        avg7: 120,
        avg30: 120,
        avg30_last_month: null,
        slope7: null,
        r2_7: null,
        slope30: null,
        r2_30: null,
      },
    ])
      .mockResolvedValueOnce([
        {
          type: "BLOOD_PRESSURE_SYS",
          value: 120,
          measured_at: measuredAt,
        },
      ])
      // v1.18.10 — bpRaw runs on `$queryRawUnsafe` through the
      // source-collapsed canonical subquery. The query returns the
      // already-collapsed sys + dia rows in raw SQL snake_case shape; the
      // aggregator partitions by type in JS so the bpRawRows.sys / .dia
      // byte-shape stays identical.
      // v1.32.17 — WEIGHT now rides this same canonical pull so the route
      // can derive a local-day mood × weight series. It partitions into a
      // separate `weightRawRows` field and must not disturb sys / dia.
      .mockResolvedValueOnce([
        { type: "BLOOD_PRESSURE_SYS", measured_at: measuredAt, value: 120 },
        { type: "BLOOD_PRESSURE_DIA", measured_at: measuredAt, value: 80 },
        { type: "WEIGHT", measured_at: measuredAt, value: 81.4 },
      ]);

    const result = await buildComprehensiveAggregate("user-bp");
    expect(result.bpRawRows.sys).toEqual([{ measuredAt, value: 120 }]);
    expect(result.bpRawRows.dia).toEqual([{ measuredAt, value: 80 }]);
    // WEIGHT partitions into its own field; sys / dia stay byte-identical.
    expect(result.weightRawRows).toEqual([{ measuredAt, value: 81.4 }]);
    // The widened pull selects WEIGHT alongside the BP types in one query.
    const bpPullSql = UNSAFE.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => sql.includes("'WEIGHT'"));
    expect(bpPullSql).toBeTruthy();
    // The BP pull must route through the canonical-source subquery (the
    // collapse fires in SQL); pin the marker so a revert to a plain findMany
    // (double-counting overlapping sources) fails here.
    const bpSql = UNSAFE.mock.calls
      .map((c) => String(c[0]))
      .find((sql) => sql.includes("BLOOD_PRESSURE_SYS"));
    expect(bpSql).toContain("user_id");
    expect(FIND_MANY).not.toHaveBeenCalled();
  });
});
