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
    measurement: { findFirst: vi.fn() },
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

import { prisma } from "@/lib/db";
import { computeSummariesSlice } from "../summaries-slice";

const RAW = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const MEASUREMENT_FIND_FIRST =
  prisma.measurement.findFirst as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY =
  prisma.measurementRollup.findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_FIRST =
  prisma.measurementRollup.findFirst as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  RAW.mockReset();
  MEASUREMENT_FIND_FIRST.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  ROLLUP_FIND_FIRST.mockReset();
  ROLLUP_FIND_MANY.mockResolvedValue([]);
  ROLLUP_FIND_FIRST.mockResolvedValue(null);
  MEASUREMENT_FIND_FIRST.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeSummariesSlice", () => {
  describe("cold fallback — empty rollup table", () => {
    it("returns the empty-summary skeleton when the user has no rows", async () => {
      // v1.4.48 M0 — cold path now issues two aggregate queries
      // (`allTime` + `windowed`) instead of one fat aggregate, so the
      // $queryRaw call count is 4 instead of 3:
      // 1. per-type coverage probe — empty ⇒ cold path.
      // 2. all-time aggregate ($queryRaw) — empty.
      // 3. windowed aggregate ($queryRaw, 90-day cap) — empty.
      // 4. latests ($queryRaw) — empty.
      RAW.mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await computeSummariesSlice("user-1");

      expect(result.summaries.WEIGHT).toEqual({
        count: 0,
        latest: null,
        min: null,
        max: null,
        mean: null,
        avg7: null,
        avg30: null,
        slope7: null,
        slope30: null,
        slope90: null,
        anomalyCount: 0,
        avg30LastMonth: null,
        avg30LastYear: null,
      });
      expect(result.bmi).toBeNull();
      expect(RAW).toHaveBeenCalledTimes(4);
    });

    it("maps a populated heavy aggregate row into the DataSummary shape on cold path", async () => {
      // v1.4.48 M0 — cold path now splits the heavy aggregate into
      // all-time + 90-day-capped windowed queries. Mock order:
      // 1. coverage probe (WEIGHT uncovered → cold path)
      // 2. all-time aggregate (count / min / max / mean)
      // 3. windowed aggregate (avg7/30 + slope/r²)
      // 4. latests
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }])
        .mockResolvedValueOnce([
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
      expect(weight.anomalyCount).toBe(0);
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
      expect(weight.slope90).toEqual({
        slope: 0.001,
        direction: "stable",
        confidence: 0.12,
      });
    });

    it("returns a null slope tuple when the SQL slope is null (insufficient rows)", async () => {
      RAW.mockResolvedValueOnce([{ type: "PULSE", has_buckets: false }])
        .mockResolvedValueOnce([
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
      expect(result.summaries.PULSE.slope90).toBeNull();
    });

    it("surfaces lastSeenByType from the DISTINCT ON pass's measured_at", async () => {
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }])
        .mockResolvedValueOnce([
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
      RAW.mockResolvedValueOnce([{ type: "PULSE", has_buckets: false }])
        .mockResolvedValueOnce([
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
      // v1.4.37.2 — the slim slice's rollup read is now a per-type
      // GROUP BY ($queryRaw) instead of a row-per-bucket findMany,
      // so the mock sequence is:
      // 1. per-type coverage probe — WEIGHT fully covered ⇒ happy path.
      // 2. narrow aggregate — windowed/regression only.
      // 3. latests.
      // 4. rollup GROUP BY — one row per type with count/min/max/mean
      //    already composed server-side.
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            avg7: 82,
            avg30: 82.5,
            slope7: 0.02,
            r2_7: 0.5,
            slope30: 0.01,
            r2_30: 0.4,
            slope90: 0.005,
            r2_90: 0.2,
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

      const result = await computeSummariesSlice("user-rollup");
      const weight = result.summaries.WEIGHT;

      expect(weight.count).toBe(20);
      expect(weight.min).toBe(79.5);
      expect(weight.max).toBe(84.0);
      expect(weight.mean).toBe(82);
      expect(weight.latest).toBe(82.7);
      expect(weight.avg7).toBe(82);
      expect(weight.slope7).toEqual({
        slope: 0.02,
        direction: "up",
        confidence: 0.5,
      });

      // probe + narrow aggregate + latests + rollup GROUP BY
      // (v1.4.37.2 — the prior `findMany` is gone). No heavy aggregate.
      expect(RAW).toHaveBeenCalledTimes(4);
      // v1.4.40 W-WMY-WIRE — the year-ago baseline probe runs
      // `readBestGranularityRollups(userId, type, 395)` per
      // type-with-data via `prisma.measurementRollup.findMany`. The
      // 395-day window skips the YEAR floor (731 d) and walks MONTH
      // → WEEK → DAY on full coverage miss; the default mock returns
      // `[]` so all three reachable tiers probe.
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(3);
    });
  });

  /**
   * v1.4.40 W-WMY-WIRE — pin the wiring of the WMY readers into the
   * slim slice. The pre-v1.4.40 shape hardcoded `avg30LastYear` to
   * `null`; we now populate it from `readBestGranularityRollups` when
   * the YEAR / MONTH / WEEK / DAY tier carries buckets that overlap
   * the `[now-395d, now-365d)` slice.
   */
  describe("year-over-year wiring (avg30LastYear)", () => {
    it("populates avg30LastYear from MONTH buckets that overlap the year-ago slice", async () => {
      // Coverage probe shows WEIGHT covered → rollup happy path.
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            avg7: 82,
            avg30: 82.5,
            slope7: 0,
            r2_7: 0,
            slope30: 0,
            r2_30: 0,
            slope90: 0,
            r2_90: 0,
          },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 82.7, measured_at: new Date() },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", count: 5, min: 82, max: 84, mean: 83 },
        ]);

      // Year-ago slice MONTH bucket — `bucketStart` placed 380 days
      // ago so it falls inside `[now-395d, now-365d)`. Single bucket
      // (count=10, mean=85) → weighted mean = 85.
      const yearAgoBucketStart = new Date(
        Date.now() - 380 * 24 * 60 * 60 * 1000,
      );
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: yearAgoBucketStart,
          count: 10,
          mean: 85,
          sd: 1,
          slope: 0,
          r2: 0,
          sumValue: null,
          minValue: 83,
          maxValue: 87,
        },
      ]);

      const result = await computeSummariesSlice("user-yoy");

      expect(result.summaries.WEIGHT.avg30LastYear).toBe(85);
      // Router asked MONTH first (395 > 181, 395 < 731 → skip YEAR).
      expect(ROLLUP_FIND_MANY.mock.calls[0][0].where.granularity).toBe("MONTH");
    });

    it("leaves avg30LastYear null when no bucket overlaps the year-ago slice", async () => {
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            avg7: 82,
            avg30: 82.5,
            slope7: 0,
            r2_7: 0,
            slope30: 0,
            r2_30: 0,
            slope90: 0,
            r2_90: 0,
          },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 82.7, measured_at: new Date() },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", count: 5, min: 82, max: 84, mean: 83 },
        ]);

      // MONTH bucket placed 30 days ago — inside the YEAR / MONTH /
      // WEEK 395-day window the router asks for, but outside the
      // `[now-395d, now-365d)` slice. The helper returns null.
      const recentBucket = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          bucketStart: recentBucket,
          count: 10,
          mean: 82,
          sd: 1,
          slope: 0,
          r2: 0,
          sumValue: null,
          minValue: 80,
          maxValue: 84,
        },
      ]);

      const result = await computeSummariesSlice("user-recent");

      expect(result.summaries.WEIGHT.avg30LastYear).toBeNull();
    });

    it("leaves avg30LastYear null when every granularity misses (no coverage)", async () => {
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            avg7: 82,
            avg30: 82.5,
            slope7: 0,
            r2_7: 0,
            slope30: 0,
            r2_30: 0,
            slope90: 0,
            r2_90: 0,
          },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 82.7, measured_at: new Date() },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", count: 5, min: 82, max: 84, mean: 83 },
        ]);

      // Default mock returns `[]` for every findMany call → router
      // walks YEAR → MONTH → WEEK → DAY and gives up.
      ROLLUP_FIND_MANY.mockResolvedValue([]);

      const result = await computeSummariesSlice("user-empty-yoy");

      expect(result.summaries.WEIGHT.avg30LastYear).toBeNull();
      // 395d window skips YEAR (floor 731 d) → MONTH → WEEK → DAY,
      // three reachable tiers all probed on full coverage miss.
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(3);
    });

    it("only probes types that actually have data in the current window", async () => {
      // v1.4.48 M0 — empty coverage map ⇒ `isFullyCovered` returns
      // false ⇒ cold-fallback path. Cold path now issues 4 raw
      // queries (coverage probe + all-time + windowed + latests),
      // all returning empty arrays here ⇒ no types-with-data ⇒ the
      // year-ago probe must NOT fan out.
      RAW.mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
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
      const queries: string[] = [];
      RAW.mockImplementation((strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        return Promise.resolve([]);
      });

      // Trigger the rollup-fresh path so we capture the `narrows` SQL.
      // Coverage probe returns one covered type ⇒ `isFullyCovered`
      // is true ⇒ `computeFromRollups` runs.
      RAW.mockImplementationOnce((strings: TemplateStringsArray) => {
        queries.push(strings.join("?"));
        return Promise.resolve([{ type: "WEIGHT", has_buckets: true }]);
      });
      await computeSummariesSlice("user-rollup-pin");

      // Trigger the cold-fallback path so we capture the `windowed`
      // SQL. Empty coverage map ⇒ `isFullyCovered` is false ⇒
      // `computeFromLiveAggregate` runs.
      await computeSummariesSlice("user-cold-pin");

      const joined = queries.join("\n---\n");
      // Both windowed scans must carry the outer 90-day cap.
      const capMatches = joined.match(
        /AND m\."measured_at" >= NOW\(\) - INTERVAL '90 days'/g,
      );
      expect(capMatches).not.toBeNull();
      // narrows (rollup-fresh) + windowed (cold-fallback) = 2 caps.
      expect(capMatches?.length).toBeGreaterThanOrEqual(2);
    });
  });
});

