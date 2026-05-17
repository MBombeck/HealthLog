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

import { prisma } from "@/lib/db";
import { buildComprehensiveAggregate } from "../comprehensive-aggregator";

const RAW = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const FIND_MANY =
  prisma.measurement.findMany as unknown as ReturnType<typeof vi.fn>;
const MEASUREMENT_FIND_FIRST =
  prisma.measurement.findFirst as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_MANY =
  prisma.measurementRollup.findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_FIRST =
  prisma.measurementRollup.findFirst as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  RAW.mockReset();
  FIND_MANY.mockReset();
  MEASUREMENT_FIND_FIRST.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  ROLLUP_FIND_FIRST.mockReset();
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
      // 1. per-type coverage probe — WEIGHT fully covered ⇒ happy path.
      // 2. narrow aggregate ($queryRaw) — windowed/regression columns only.
      // 3. latests ($queryRaw).
      // 4. firstMeasurementAt ($queryRaw).
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: true }])
        .mockResolvedValueOnce([
          {
            type: "WEIGHT",
            count: BigInt(42),
            stddev_value: 1.2,
            anomaly_count: BigInt(3),
            avg7: 81.9,
            avg30: 82.1,
            avg30_last_month: 83.0,
            slope7: -0.014,
            r2_7: 0.65,
            slope30: -0.005,
            r2_30: 0.42,
            slope90: 0.001,
            r2_90: 0.12,
          },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 81.4, measured_at: now },
        ])
        .mockResolvedValueOnce([
          { first_at: new Date(now.getTime() - 86400000) },
        ]);

      // DAY buckets compose to count=42, min=79.2, max=84.1, mean=82.05.
      // The summary's count/min/max/mean read from these buckets — NOT
      // from a heavy live aggregate column.
      ROLLUP_FIND_MANY.mockResolvedValueOnce([
        {
          type: "WEIGHT",
          bucketStart: new Date("2026-05-10T00:00:00.000Z"),
          count: 20,
          mean: 81.0,
          minValue: 79.2,
          maxValue: 82.5,
        },
        {
          type: "WEIGHT",
          bucketStart: new Date("2026-05-11T00:00:00.000Z"),
          count: 22,
          mean: 83.0,
          minValue: 80.0,
          maxValue: 84.1,
        },
      ]);

      // v1.4.38 W-F — sys + dia merged into a single `findMany`
      // (`type: { in: [...] }`) → one mock call carrying both rows
      // (empty here since the rollup-fresh fixture doesn't exercise
      // the BP pairing). The aggregator partitions by type in JS so
      // the bpRawRows.sys / .dia byte-shape is preserved.
      FIND_MANY.mockResolvedValueOnce([]);

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
      expect(weight.slope7).toEqual({
        slope: -0.014,
        direction: "down",
        confidence: 0.65,
      });
      expect(result.dailyByType.WEIGHT).toEqual([
        { day: "2026-05-10", value: 81 },
        { day: "2026-05-11", value: 83 },
      ]);

      // Contract pin — the heavy aggregate path is NOT exercised on the
      // rollup-fresh branch. The $queryRaw calls land on the COUNT
      // probe + narrow aggregate + DISTINCT-ON latest + first_at, NOT
      // the legacy heavy COUNT/MIN/MAX/AVG query. We assert by call
      // count + by checking that the narrow projection (no min_value /
      // max_value / mean_value cols) is what landed.
      expect(RAW).toHaveBeenCalledTimes(4);
      // v1.4.38 W-F — sys + dia merged into a single round-trip.
      expect(FIND_MANY).toHaveBeenCalledTimes(1);
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(1);
    });
  });

  describe("cold fallback when no rollup buckets exist", () => {
    it("returns an empty bundle for a user with no measurements and no rollups", async () => {
      // 1. per-type coverage probe — empty (no measurements) ⇒ cold path.
      // 2. heavy aggregate ($queryRaw) — empty.
      // 3. latests ($queryRaw) — empty.
      // No firstMeasurementAt query when totalMeasurements === 0.
      RAW.mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      // v1.4.38 W-F — sys + dia merged into one `findMany`.
      FIND_MANY.mockResolvedValueOnce([]);

      const result = await buildComprehensiveAggregate("user-empty");

      expect(result.summaries).toEqual({});
      expect(result.bpRawRows.sys).toEqual([]);
      expect(result.bpRawRows.dia).toEqual([]);
      expect(result.dailyByType).toEqual({});
      expect(result.firstMeasurementAt).toBeNull();
      expect(result.totalMeasurements).toBe(0);
      expect(RAW).toHaveBeenCalledTimes(3);
      // v1.4.38 W-F — sys + dia merged → single findMany.
      expect(FIND_MANY).toHaveBeenCalledTimes(1);
      // The cold path's rollup.findMany still fires (in case some
      // buckets exist for a subset of types post-race), but returns [].
      expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(1);
    });

    it("runs the heavy aggregate when no rollup rows exist yet", async () => {
      const now = new Date();
      // 1. per-type coverage probe — WEIGHT measured but no buckets ⇒ cold path.
      // 2. heavy aggregate ($queryRaw) — populated.
      // 3. latests ($queryRaw) — populated.
      // 4. firstMeasurementAt ($queryRaw).
      RAW.mockResolvedValueOnce([{ type: "WEIGHT", has_buckets: false }])
        .mockResolvedValueOnce([
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
            slope90: 0.001,
            r2_90: 0.12,
          },
        ])
        .mockResolvedValueOnce([
          { type: "WEIGHT", value: 81.4, measured_at: now },
        ])
        .mockResolvedValueOnce([
          { first_at: new Date(now.getTime() - 86400000) },
        ]);
      // v1.4.38 W-F — sys + dia merged into one round-trip.
      FIND_MANY.mockResolvedValueOnce([]);

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
      expect(weight.slope90).toEqual({
        slope: 0.001,
        direction: "stable",
        confidence: 0.12,
      });

      expect(result.totalMeasurements).toBe(42);
      expect(result.firstMeasurementAt).toBeInstanceOf(Date);
      // The cold path's `dailyByType` is sourced from the same rollup
      // findMany call (returns [] here since no buckets exist). The
      // contract is: even on cold mount, if buckets do exist for some
      // type, they feed `dailyByType` so the v1.4.35 shape is stable.
      expect(result.dailyByType.WEIGHT).toBeUndefined();
    });
  });

  it("threads sys/dia raw rows through bpRawRows so 5-min pairing survives", async () => {
    const measuredAt = new Date("2026-05-10T08:00:00Z");
    // Cold path so the heavy aggregate fires (BP type lacks coverage).
    RAW.mockResolvedValueOnce([{ type: "BLOOD_PRESSURE_SYS", has_buckets: false }])
      .mockResolvedValueOnce([
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
          slope90: null,
          r2_90: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          type: "BLOOD_PRESSURE_SYS",
          value: 120,
          measured_at: measuredAt,
        },
      ])
      .mockResolvedValueOnce([{ first_at: measuredAt }]);
    // v1.4.38 W-F — single merged `findMany` returning both sys + dia
    // rows tagged by `type`. The aggregator partitions in JS, so the
    // bpRawRows.sys / .dia shape stays byte-identical.
    FIND_MANY.mockResolvedValueOnce([
      { type: "BLOOD_PRESSURE_SYS", measuredAt, value: 120 },
      { type: "BLOOD_PRESSURE_DIA", measuredAt, value: 80 },
    ]);

    const result = await buildComprehensiveAggregate("user-bp");
    expect(result.bpRawRows.sys).toEqual([{ measuredAt, value: 120 }]);
    expect(result.bpRawRows.dia).toEqual([{ measuredAt, value: 80 }]);
  });
});
