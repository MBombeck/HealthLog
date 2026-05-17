/**
 * v1.4.35 — unit pin for `buildComprehensiveAggregate`.
 *
 * Heavier integration coverage (real Postgres, real `regr_slope`,
 * cache hit/miss assertions) lives in
 * `tests/integration/insights-comprehensive-cache.test.ts`. This file
 * mocks `$queryRaw` and Prisma's `measurement.findMany` so the shape +
 * rounding + slope-direction contracts are pinned without a container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    measurement: { findMany: vi.fn() },
    // v1.4.35 — the rollup read inside the Promise.all + the
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
const ROLLUP_FIND_MANY =
  prisma.measurementRollup.findMany as unknown as ReturnType<typeof vi.fn>;
const ROLLUP_FIND_FIRST =
  prisma.measurementRollup.findFirst as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  RAW.mockReset();
  FIND_MANY.mockReset();
  ROLLUP_FIND_MANY.mockReset();
  ROLLUP_FIND_FIRST.mockReset();
  // `ensureUserRollupsFresh` calls `prisma.measurement.findFirst`;
  // we don't have it on the mock above, so it throws and the helper
  // swallows + returns `{ recomputed: false }`. The bucket read
  // proceeds against whatever we mock on `measurementRollup.findMany`.
  // We default both to empty so individual tests opt in to data.
  ROLLUP_FIND_MANY.mockResolvedValue([]);
  ROLLUP_FIND_FIRST.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildComprehensiveAggregate", () => {
  it("returns an empty bundle for a user with no measurements", async () => {
    // v1.4.35 pass order: aggregates ($queryRaw), latests ($queryRaw),
    // dayBuckets (rollup.findMany — defaulted to [] in beforeEach),
    // sysRaw (findMany), diaRaw (findMany). The `firstMeasurementAt`
    // $queryRaw is skipped when totalMeasurements === 0.
    RAW.mockResolvedValueOnce([]) // aggregates
      .mockResolvedValueOnce([]); // latests
    FIND_MANY.mockResolvedValueOnce([]) // sys
      .mockResolvedValueOnce([]); // dia

    const result = await buildComprehensiveAggregate("user-empty");

    expect(result.summaries).toEqual({});
    expect(result.bpRawRows.sys).toEqual([]);
    expect(result.bpRawRows.dia).toEqual([]);
    expect(result.dailyByType).toEqual({});
    expect(result.firstMeasurementAt).toBeNull();
    expect(result.totalMeasurements).toBe(0);
    // 2 $queryRaw (aggregates, latests) + 2 findMany + 1 rollup.findMany.
    // No firstMeasurementAt query when total === 0.
    expect(RAW).toHaveBeenCalledTimes(2);
    expect(FIND_MANY).toHaveBeenCalledTimes(2);
    expect(ROLLUP_FIND_MANY).toHaveBeenCalledTimes(1);
  });

  it("maps a populated WEIGHT aggregate into the DataSummary shape", async () => {
    const now = new Date();
    RAW.mockResolvedValueOnce([
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
      .mockResolvedValueOnce([{ type: "WEIGHT", value: 81.4, measured_at: now }])
      .mockResolvedValueOnce([{ first_at: new Date(now.getTime() - 86400000) }]);
    // v1.4.35 — DAY buckets feed both the per-type count/min/max/mean
    // composition AND `dailyByType`. The two buckets compose to a
    // count of 42 → matches the live aggregate's BigInt(42) → the
    // parity check elects the rollup-derived values, which equal the
    // live values byte-for-byte (chosen on purpose so the assertions
    // exercise the rollup path while keeping the previous expected
    // numbers stable).
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
    FIND_MANY.mockResolvedValueOnce([]) // sys
      .mockResolvedValueOnce([]); // dia

    const result = await buildComprehensiveAggregate("user-pop");
    const weight = result.summaries.WEIGHT;

    expect(weight.count).toBe(42);
    expect(weight.latest).toBe(81.4);
    // Composed from buckets: min(79.2, 80.0) = 79.2; max(82.5, 84.1) = 84.1.
    expect(weight.min).toBe(79.2);
    expect(weight.max).toBe(84.1);
    // Weighted mean = (20 * 81 + 22 * 83) / 42 = 3446 / 42 = 82.0476…,
    // round2 → 82.05. Matches the live `AVG` value of 82.05.
    expect(weight.mean).toBe(82.05);
    expect(weight.avg7).toBe(81.9);
    expect(weight.avg30).toBe(82.1);
    expect(weight.avg30LastMonth).toBe(83.0);
    // Always null in the 90-day window — preserved legacy semantics.
    expect(weight.avg30LastYear).toBeNull();
    expect(weight.anomalyCount).toBe(3);
    // Slope direction matches the JS threshold rules:
    //   -0.014  → "down" (|s| >= 0.01)
    //   -0.005  → "stable" (|s| < 0.01)
    //    0.001  → "stable"
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
    // `dailyByType` is sourced from the same DAY buckets; the entries
    // are the bucket means rounded to 2 decimals, keyed on the UTC
    // bucket-start date.
    expect(result.dailyByType.WEIGHT).toEqual([
      { day: "2026-05-10", value: 81 },
      { day: "2026-05-11", value: 83 },
    ]);
  });

  it("threads sys/dia raw rows through bpRawRows so 5-min pairing survives", async () => {
    const measuredAt = new Date("2026-05-10T08:00:00Z");
    RAW.mockResolvedValueOnce([
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
    FIND_MANY.mockResolvedValueOnce([
      { measuredAt, value: 120 },
    ]).mockResolvedValueOnce([{ measuredAt, value: 80 }]);

    const result = await buildComprehensiveAggregate("user-bp");
    expect(result.bpRawRows.sys).toEqual([{ measuredAt, value: 120 }]);
    expect(result.bpRawRows.dia).toEqual([{ measuredAt, value: 80 }]);
  });
});
