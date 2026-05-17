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
      // 1. per-type coverage probe — empty ⇒ cold path.
      // 2. heavy aggregate ($queryRaw) — empty.
      // 3. latests ($queryRaw) — empty.
      RAW.mockResolvedValueOnce([])
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
      expect(RAW).toHaveBeenCalledTimes(3);
    });

    it("maps a populated heavy aggregate row into the DataSummary shape on cold path", async () => {
      // Coverage probe returns WEIGHT with no buckets → cold path.
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            count: BigInt(42),
            min_value: 79.2,
            max_value: 84.1,
            mean_value: 82.05,
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
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(0);
    });
  });
});
