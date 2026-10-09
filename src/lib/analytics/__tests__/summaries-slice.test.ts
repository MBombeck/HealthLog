/**
 * Unit-level pin for the slim summaries slice. Heavier integration
 * coverage lives in `tests/integration/analytics-summaries-slice.test.ts`
 * (real Postgres, real `regr_slope`); this file mocks `$queryRaw` so
 * the slope/round/empty/path-selection contracts are pinned without
 * a container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    // v1.11.1 — the data-aggregate queries inside `computeFromRollups`
    // and `computeFromLiveAggregate` now splice a whitelisted
    // source-rank CASE and bind `userId` as `$1`, so they run via
    // `$queryRawUnsafe(sql, userId)` rather than the tagged-template
    // `$queryRaw`. The coverage probe stays on `$queryRaw`.
    $queryRawUnsafe: vi.fn(),
    // v1.11.1 — `loadUserSourcePriority` reads the user's
    // `sourcePriorityJson` to build the rank ladders. `null` here →
    // default ladders.
    user: { findUnique: vi.fn() },
    measurement: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    // v1.4.36 — slim slice reads DAY buckets from `measurement_rollups`
    // on the happy path. The freshness watermark inside
    // `ensureUserRollupsFresh` also pokes `measurementRollup.findFirst`;
    // mock both so the helper runs without a container.
    measurementRollup: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

// v1.11.1 — `computeFromRollups` / `computeFromLiveAggregate` build a
// source-rank CASE via `@/lib/analytics/source-rank-sql` and splice it
// into the data-aggregate SQL. The builder's own correctness is pinned
// in its dedicated suite (and the integration suite runs the real SQL);
// here we stub it to deterministic, side-effect-free fragments so the
// slice's plumbing — path selection, slope/round/empty contracts, the
// 90-day FILTER caps the slice itself writes — is exercised without
// coupling the slice unit test to the rank builder's enum-whitelist
// internals.
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
    canonicalMeasurementsCte: vi.fn(cte),
  };
});

import { prisma } from "@/lib/db";
import { canonicalMeasurementsCte } from "@/lib/analytics/source-rank-sql";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import { computeSummariesSlice } from "../summaries-slice";

const RAW = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const UNSAFE = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;
const USER_FIND_UNIQUE = prisma.user.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const MEASUREMENT_FIND_FIRST = prisma.measurement
  .findFirst as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY = prisma.measurementRollup
  .findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_FIRST = prisma.measurementRollup
  .findFirst as unknown as ReturnType<typeof vi.fn>;
const CANONICAL_FROM = canonicalMeasurementsCte as unknown as ReturnType<
  typeof vi.fn
>;

beforeEach(() => {
  RAW.mockReset();
  UNSAFE.mockReset();
  USER_FIND_UNIQUE.mockReset();
  MEASUREMENT_FIND_FIRST.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  ROLLUP_FIND_FIRST.mockReset();
  // clear (not reset) — preserve the FROM-clause stub implementation,
  // drop cross-test call history so the cap assertion only sees this
  // test's calls.
  CANONICAL_FROM.mockClear();
  // null → loadUserSourcePriority returns null → default rank ladders.
  USER_FIND_UNIQUE.mockResolvedValue(null);
  ROLLUP_FIND_MANY.mockResolvedValue([]);
  ROLLUP_FIND_FIRST.mockResolvedValue(null);
  MEASUREMENT_FIND_FIRST.mockResolvedValue(null);
  // v1.37.19 (A6-10) — default the tagged-template RAW reads (the coverage
  // probe + the pre-fold all-time remainder) to empty; individual tests
  // queue their own `mockResolvedValueOnce` sequences on top.
  RAW.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeSummariesSlice", () => {
  describe("cold fallback — empty rollup table", () => {
    it("returns the empty-summary skeleton when the user has no rows", async () => {
      // v1.11.1 — the coverage probe stays on `$queryRaw` (1 RAW call);
      // the three data-aggregate queries moved to `$queryRawUnsafe`:
      // 1. per-type coverage probe ($queryRaw) — empty ⇒ cold path.
      // 2. all-time aggregate ($queryRawUnsafe) — empty.
      // 3. windowed aggregate ($queryRawUnsafe, 90-day cap) — empty.
      // 4. latests ($queryRawUnsafe) — empty.
      RAW.mockResolvedValueOnce([]);
      UNSAFE.mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await computeSummariesSlice("user-1");

      expect(result.summaries.WEIGHT).toEqual({
        count: 0,
        latest: null,
        min: null,
        max: null,
        mean: null,
        median: null,
        avg7: null,
        avg30: null,
        slope7: null,
        slope30: null,
        avg30LastMonth: null,
        avg30LastYear: null,
      });
      expect(result.bmi).toBeNull();
      // 1 RAW coverage probe + 3 UNSAFE data queries.
      expect(RAW).toHaveBeenCalledTimes(1);
      expect(UNSAFE).toHaveBeenCalledTimes(3);
    });

    it("maps a populated heavy aggregate row into the DataSummary shape on cold path", async () => {
      // v1.4.48 M0 — cold path now splits the heavy aggregate into
      // all-time + 90-day-capped windowed queries. Mock order:
      // 1. coverage probe (WEIGHT uncovered → cold path)
      // 2. all-time aggregate (count / min / max / mean)
      // 3. windowed aggregate (avg7/30 + slope/r²)
      // 4. latests
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }]);
      UNSAFE.mockResolvedValueOnce([
        {
          type: "WEIGHT",
          count: BigInt(42),
          min_value: 79.2,
          max_value: 84.1,
          mean_value: 82.05,
        },
      ])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            avg7: 81.9,
            avg30: 82.1,
            slope7: -0.014,
            r2_7: 0.65,
            slope30: -0.005,
            r2_30: 0.42,
            slope90: 0.001,
            r2_90: 0.12,
          },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 81.4, measured_at: new Date() },
        ]);

      const result = await computeSummariesSlice("user-1");
      const weight = result.summaries.WEIGHT;

      expect(weight.count).toBe(42);
      expect(weight.latest).toBe(81.4);
      expect(weight.min).toBe(79.2);
      expect(weight.max).toBe(84.1);
      expect(weight.mean).toBe(82.05);
      expect(weight.avg7).toBe(81.9);
      expect(weight.avg30).toBe(82.1);
      // anomalyCount / slope90 left the wire shape in v1.37.19 — computed
      // by the insights pipeline's own reads, never serialised here.
      expect("anomalyCount" in weight).toBe(false);
      expect("slope90" in weight).toBe(false);
      expect(weight.avg30LastMonth).toBeNull();
      expect(weight.avg30LastYear).toBeNull();
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
    });

    it("returns a null slope tuple when the SQL slope is null (insufficient rows)", async () => {
      RAW.mockResolvedValueOnce([{ type: "PULSE", has_buckets: false }]);
      UNSAFE.mockResolvedValueOnce([
        {
          type: "PULSE",
          count: BigInt(1),
          min_value: 72,
          max_value: 72,
          mean_value: 72,
        },
      ])
        .mockResolvedValueOnce([
          {
            type: "PULSE",
            avg7: 72,
            avg30: 72,
            slope7: null,
            r2_7: null,
            slope30: null,
            r2_30: null,
            slope90: null,
            r2_90: null,
          },
        ])
        .mockResolvedValueOnce([
          { type: "PULSE", value: 72, measured_at: new Date() },
        ]);

      const result = await computeSummariesSlice("user-1");
      expect(result.summaries.PULSE.slope7).toBeNull();
      expect(result.summaries.PULSE.slope30).toBeNull();
    });

    it("surfaces lastSeenByType from the DISTINCT ON pass's measured_at", async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }]);
      UNSAFE.mockResolvedValueOnce([
        {
          type: "WEIGHT",
          count: BigInt(5),
          min_value: 80,
          max_value: 84,
          mean_value: 82,
        },
      ])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            avg7: null,
            avg30: 82,
            slope7: null,
            r2_7: null,
            slope30: 0.005,
            r2_30: 0.2,
            slope90: null,
            r2_90: null,
          },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 82.3, measured_at: tenDaysAgo },
        ]);

      const result = await computeSummariesSlice("user-1");
      const ws = result.lastSeenByType.WEIGHT;
      expect(ws).not.toBeNull();
      expect(ws?.daysAgo).toBeGreaterThanOrEqual(9);
      expect(ws?.daysAgo).toBeLessThanOrEqual(11);
      expect(ws?.lastSeenAt).toBe(tenDaysAgo.toISOString());
      expect(result.lastSeenByType.PULSE).toBeNull();
    });

    it("seeds the latest value from the DISTINCT ON pass per type", async () => {
      RAW.mockResolvedValueOnce([{ type: "PULSE", has_buckets: false }]);
      UNSAFE.mockResolvedValueOnce([
        {
          type: "PULSE",
          count: BigInt(3),
          min_value: 60,
          max_value: 95,
          mean_value: 77,
        },
      ])
        .mockResolvedValueOnce([
          {
            type: "PULSE",
            avg7: 77,
            avg30: 77,
            slope7: 0,
            r2_7: 0,
            slope30: 0,
            r2_30: 0,
            slope90: 0,
            r2_90: 0,
          },
        ])
        .mockResolvedValueOnce([
          { type: "PULSE", value: 88, measured_at: new Date() },
        ]);

      const result = await computeSummariesSlice("user-1");
      expect(result.summaries.PULSE.latest).toBe(88);
      expect(result.summaries.PULSE.max).toBe(95);
    });
  });

  describe("rollup-fresh happy path", () => {
    it("composes count/min/max/mean from the per-type rollup GROUP BY without running the heavy aggregate", async () => {
      // v1.11.1 — the per-type coverage probe stays on `$queryRaw`; the
      // three rollup-path data queries moved to `$queryRawUnsafe`:
      // 1. per-type coverage probe ($queryRaw) — WEIGHT fully covered
      //    ⇒ happy path.
      // 2. narrow aggregate ($queryRawUnsafe) — windowed/regression only.
      // 3. latests ($queryRawUnsafe).
      // 4. rollup GROUP BY ($queryRawUnsafe) — one row per type with
      //    count/min/max/mean already composed server-side.
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }]);
      UNSAFE.mockResolvedValueOnce([
        {
          type: "WEIGHT",
          avg7: 82,
          avg30: 82.5,
          median: 82.1,
          // v1.20.0 F6 — the narrow query no longer carries slope/r²; those
          // compose from the accumulator buckets mocked below.
        },
      ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 82.7, measured_at: new Date() },
        ])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            // pre-aggregated server-side: SUM(count), MIN(min),
            // MAX(max), weighted mean — equivalent to the two-bucket
            // fixture below.
            //   bucket A: count=10, mean=81.0, min=79.5, max=82.0
            //   bucket B: count=10, mean=83.0, min=81.5, max=84.0
            //   ⇒ count=20, min=79.5, max=84.0, mean=82
            count: 20,
            min: 79.5,
            max: 84.0,
            mean: 82.0,
          },
        ]);

      // v1.20.0 F6 — the 90-day accumulator findMany (first measurementRollup
      // .findMany in the Promise.all). Two single-reading DAY buckets one day
      // apart inside the 7-day window: x = epoch-days, y = 82.00 then 82.02.
      // composeWindowedRegression over them yields slope = 0.02/day with a
      // perfect fit (r² = 1) — a deterministic, hand-checkable regression.
      const dayB = startOfUtcDay(new Date());
      const dayA = startOfUtcDay(new Date(Date.now() - 24 * 60 * 60 * 1000));
      const xA = dayA.getTime() / 86_400_000;
      const xB = dayB.getTime() / 86_400_000;
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          type: "WEIGHT",
          source: "MANUAL",
          bucketStart: dayA,
          count: 1,
          mean: 82.0,
          sumX: xA,
          sumXy: xA * 82.0,
          sumXx: xA * xA,
          sumYy: 82.0 * 82.0,
        },
        {
          type: "WEIGHT",
          source: "MANUAL",
          bucketStart: dayB,
          count: 1,
          mean: 82.02,
          sumX: xB,
          sumXy: xB * 82.02,
          sumXx: xB * xB,
          sumYy: 82.02 * 82.02,
        },
      ]);

      const result = await computeSummariesSlice("user-rollup");
      const weight = result.summaries.WEIGHT;

      expect(weight.count).toBe(20);
      expect(weight.min).toBe(79.5);
      expect(weight.max).toBe(84.0);
      expect(weight.mean).toBe(82);
      // v1.8.5 — the windowed median flows through from the narrow
      // `PERCENTILE_CONT` column onto the slim summary.
      expect(weight.median).toBe(82.1);
      expect(weight.latest).toBe(82.7);
      expect(weight.avg7).toBe(82);
      // v1.20.0 F6 — slope composed from the accumulator buckets: a clean
      // +0.02/day with a perfect two-point fit.
      expect(weight.slope7).toEqual({
        slope: 0.02,
        direction: "up",
        confidence: 1,
      });

      // 1 RAW coverage probe + 3 UNSAFE data queries (narrow aggregate
      // + latests + rollup GROUP BY; v1.4.37.2 — the prior `findMany`
      // is gone). No heavy aggregate. v1.37.19 (A6-10) — the second RAW
      // call is the pre-fold all-time remainder splice.
      expect(RAW).toHaveBeenCalledTimes(2);
      expect(UNSAFE).toHaveBeenCalledTimes(3);
      // The 90-day accumulator findMany plus one year-ago DAY read per
      // type-with-data.
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(2);
    });

    // Watched red: with the pre-fold splice removed from the rollup path
    // (the pre-v1.37.19 assembly used the GROUP BY figures verbatim), the
    // count / min / max / mean assertions fail — an account with rows
    // older than the 5-year fold window had its "all-time" figures
    // silently truncated to the window while the live fallback reported
    // the true numbers.
    it("splices rows older than the fold window into the all-time figures (A6-10)", async () => {
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }]) // probe
        .mockResolvedValueOnce([
          // pre-fold remainder: 5 ancient readings, heavier and wider.
          { type: "WEIGHT", count: 5, min: 70, max: 95, mean: 90 },
        ]);
      UNSAFE.mockResolvedValueOnce([
        { type: "WEIGHT", avg7: 82, avg30: 82.5, median: 82.1 },
      ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 82.7, measured_at: new Date() },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", count: 20, min: 79.5, max: 84.0, mean: 82.0 },
        ]);

      const result = await computeSummariesSlice("user-prefold");
      const weight = result.summaries.WEIGHT;

      // 20 in-window + 5 pre-fold.
      expect(weight.count).toBe(25);
      // Envelope widens to the ancient extremes.
      expect(weight.min).toBe(70);
      expect(weight.max).toBe(95);
      // Weighted mean: (82*20 + 90*5) / 25 = 83.6.
      expect(weight.mean).toBe(83.6);
      // Windowed figures stay window-scoped.
      expect(weight.avg7).toBe(82);
    });

    it("surfaces a type whose only rows are pre-fold (no DAY bucket)", async () => {
      RAW.mockResolvedValueOnce([
        { type: "WEIGHT", has_buckets: true },
      ]).mockResolvedValueOnce([
        { type: "HEIGHT", count: 2, min: 180, max: 181, mean: 180.5 },
      ]);
      UNSAFE.mockResolvedValueOnce([]) // narrows
        .mockResolvedValueOnce([]) // latests
        .mockResolvedValueOnce([]); // rollup GROUP BY

      const result = await computeSummariesSlice("user-prefold-only");
      const height = result.summaries.HEIGHT;
      expect(height.count).toBe(2);
      expect(height.min).toBe(180);
      expect(height.max).toBe(181);
      expect(height.mean).toBe(180.5);
      // No in-window rows: every windowed field stays null.
      expect(height.avg7).toBeNull();
      expect(height.slope30).toBeNull();
    });
  });

  /**
   * `avg30LastYear` is the mean over the exact 30 UTC days that start 395
   * days ago, read from canonical DAY buckets.
   */
  describe("year-over-year wiring (avg30LastYear)", () => {
    function warmPathMocks() {
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }]);
      UNSAFE.mockResolvedValueOnce([
        { type: "WEIGHT", avg7: 82, avg30: 82.5, median: 82 },
      ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 82.7, measured_at: new Date() },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", count: 5, min: 82, max: 84, mean: 83 },
        ]);
      // The 90-day accumulator findMany runs first; empty (slope composes
      // to null, irrelevant here) so the year-ago DAY read is call #1.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([]);
    }
    function dayBucket(daysAgo: number, count: number, mean: number) {
      return {
        bucketStart: startOfUtcDay(
          new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        ),
        source: "MANUAL",
        count,
        mean,
        sd: 0,
        slope: null,
        r2: null,
        sumValue: count * mean,
        minValue: mean,
        maxValue: mean,
        sumX: null,
        sumXy: null,
        sumXx: null,
        sumYy: null,
        computedAt: new Date(),
      };
    }

    it("reads exactly the 30 days that start 395 days ago", async () => {
      warmPathMocks();
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        dayBucket(390, 10, 85),
        dayBucket(370, 30, 81),
      ]);

      const result = await computeSummariesSlice("user-yoy");

      expect(result.summaries.WEIGHT.avg30LastYear).toBe(82);
      const where = ROLLUP_FIND_MANY.mock.calls[1][0].where;
      expect(where.granularity).toBe("DAY");
      const DAY = 24 * 60 * 60 * 1000;
      expect(where.bucketStart).toEqual({
        gte: startOfUtcDay(new Date(Date.now() - 395 * DAY)),
        lt: startOfUtcDay(new Date(Date.now() - 365 * DAY)),
      });
    });

    it("leaves avg30LastYear null when no reading falls in the window", async () => {
      warmPathMocks();
      ROLLUP_FIND_MANY.mockResolvedValue([]);

      const result = await computeSummariesSlice("user-empty-yoy");

      expect(result.summaries.WEIGHT.avg30LastYear).toBeNull();
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(2);
    });

    it("only probes types that actually have data in the current window", async () => {
      // v1.4.48 M0 — empty coverage map ⇒ `isFullyCovered` returns
      // false ⇒ cold-fallback path. v1.11.1 — coverage probe stays on
      // `$queryRaw`; all-time + windowed + latests run via
      // `$queryRawUnsafe`. All return empty arrays here ⇒ no
      // types-with-data ⇒ the year-ago probe must NOT fan out.
      RAW.mockResolvedValueOnce([]);
      UNSAFE.mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await computeSummariesSlice("user-no-data");

      expect(ROLLUP_FIND_MANY).not.toHaveBeenCalled();
    });
  });

  /**
   * v1.4.48 M0 — pins the 90-day outer `measured_at` cap on the two
   * windowed measurements scans: the `narrows` query inside the
   * rollup-fresh happy path and the `windowed` query inside the
   * cold-fallback path. Both must constrain the outer WHERE to the
   * 90-day suffix so the planner does an index range scan on
   * `(user_id, type, measured_at)` instead of a full-partition scan.
   * If a future refactor drops the cap, this assertion fails before
   * the perf regression reaches main.
   */
  describe("90-day outer measured_at cap (v1.4.48 M0)", () => {
    it("applies the 90-day cap to narrows (rollup-fresh path) and windowed (cold-fallback path)", async () => {
      // v1.11.1 — the cap-bearing data queries (narrows / windowed)
      // now run via `$queryRawUnsafe(sql, userId)`, so the SQL is a
      // plain string arg[0] rather than a tagged-template
      // strings array. Capture from the UNSAFE mock. The coverage probe
      // (still `$queryRaw`) drives path selection per call.
      const queries: string[] = [];
      UNSAFE.mockImplementation((sql: string) => {
        queries.push(sql);
        return Promise.resolve([]);
      });

      // Trigger the rollup-fresh path so we capture the `narrows` SQL.
      // Coverage probe returns one covered type ⇒ `isFullyCovered`
      // is true ⇒ `computeFromRollups` runs.
      // Then the cold-fallback path (empty coverage) so we capture the
      // `windowed` SQL.
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }]);
      await computeSummariesSlice("user-rollup-pin");

      RAW.mockResolvedValueOnce([]);
      await computeSummariesSlice("user-cold-pin");

      const joined = queries.join("\n---\n");
      // v1.11.1 — the rollup-fresh `narrows` query still writes its
      // outer 90-day cap inline, now on the canonical-source subquery's
      // raw alias (`mm.`) rather than the outer `m.`. Pin that the cap
      // survives the source-rank refactor.
      const narrowsCap = joined.match(
        /AND mm\."measured_at" >= NOW\(\) - INTERVAL '90 days'/g,
      );
      expect(narrowsCap).not.toBeNull();
      expect(narrowsCap?.length).toBeGreaterThanOrEqual(1);

      // v1.11.1 — the cold-fallback `windowed` scan delegates its outer
      // 90-day cap to `canonicalMeasurementsCte(rank, "90 days")` (a CTE
      // now, so the day weights can read it twice). The
      // helper lives in `@/lib/analytics/source-rank-sql` (stubbed
      // above), so pin the contract at the call boundary: the slice
      // must ask for the 90-day window.
      expect(canonicalMeasurementsCte).toHaveBeenCalledWith(
        expect.any(String),
        "90 days",
      );
      // v1.18.10 P-7 — the `allTime` aggregate is now capped at a generous
      // 15-year scan-DoS floor (far beyond any real history) so a
      // coverage-miss cold read can't trigger an unbounded full-partition
      // scan. It no longer calls the helper without an interval.
      expect(canonicalMeasurementsCte).toHaveBeenCalledWith(
        expect.any(String),
        "15 years",
      );
    });
  });

  /**
   * A2-M2 — read-swap boundary-day consistency. The warm
   * `computeFromRollups` path windows the regression on UTC-midnight
   * (`startOfUtcDay(now − N days)` + `composeWindowedRegression`). The
   * cold-fallback `windowed` query must anchor its REGR_* FILTERs on the
   * SAME UTC-midnight boundary — `date_trunc('day', NOW() AT TIME ZONE
   * 'UTC') − INTERVAL 'N days'` — so a warm→cold coverage transition
   * returns identical boundary-day membership for slope7/30/90 instead of
   * a cache-dependent answer to the same request.
   */
  describe("A2-M2 regression-window boundary alignment", () => {
    it("anchors the cold-fallback slope FILTERs on the UTC-midnight day boundary, not the wall-clock instant", async () => {
      const queries: string[] = [];
      UNSAFE.mockImplementation((sql: string) => {
        queries.push(sql);
        return Promise.resolve([]);
      });

      // Empty coverage ⇒ cold-fallback path ⇒ the `windowed` query runs.
      RAW.mockResolvedValueOnce([]);
      await computeSummariesSlice("user-a2m2");

      const windowedSql = queries.find(
        (sql) => sql.includes("AS slope7") && sql.includes("REGR_SLOPE"),
      );
      expect(windowedSql).toBeDefined();
      const sql = windowedSql as string;

      // Every regression window (7/30 for slope + r²) anchors on the
      // day-truncated UTC boundary. Four FILTERs total (the 90-day pair
      // left with slope90 in v1.37.19).
      for (const days of ["7 days", "30 days"]) {
        expect(sql).toContain(
          `(date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '${days}') AT TIME ZONE 'UTC'`,
        );
      }
      const anchored = sql.match(
        /date_trunc\('day', NOW\(\) AT TIME ZONE 'UTC'\) - INTERVAL '(?:7|30) days'\) AT TIME ZONE 'UTC'/g,
      );
      expect(anchored?.length).toBe(4);

      // The regression windows must NOT fall back to the bare wall-clock
      // `NOW() - INTERVAL 'N days'` bound the warm path never uses for the
      // slope. Isolate the slope columns (everything from the first
      // REGR_SLOPE onward) so the avg7/avg30 windows above — which DO stay
      // wall-clock by design — don't trip the assertion.
      const slopeBlock = sql.slice(sql.indexOf("REGR_SLOPE"));
      expect(slopeBlock).not.toMatch(/WHERE m\."measured_at" >= NOW\(\) -/);
    });
  });
});
