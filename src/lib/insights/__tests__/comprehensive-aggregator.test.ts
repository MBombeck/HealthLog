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

beforeEach(() => {
  RAW.mockReset();
  FIND_MANY.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildComprehensiveAggregate", () => {
  it("returns an empty bundle for a user with no measurements", async () => {
    // Pass order: aggregates, latests, daily, sysRaw, diaRaw. The
    // `firstMeasurementAt` query is skipped when totalMeasurements === 0.
    RAW.mockResolvedValueOnce([]) // aggregates
      .mockResolvedValueOnce([]) // latests
      .mockResolvedValueOnce([]); // daily
    FIND_MANY.mockResolvedValueOnce([]) // sys
      .mockResolvedValueOnce([]); // dia

    const result = await buildComprehensiveAggregate("user-empty");

    expect(result.summaries).toEqual({});
    expect(result.bpRawRows.sys).toEqual([]);
    expect(result.bpRawRows.dia).toEqual([]);
    expect(result.dailyByType).toEqual({});
    expect(result.firstMeasurementAt).toBeNull();
    expect(result.totalMeasurements).toBe(0);
    // 3 $queryRaw calls (aggregates, latests, daily) + 2 findMany.
    // No firstMeasurementAt query when total === 0.
    expect(RAW).toHaveBeenCalledTimes(3);
    expect(FIND_MANY).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce([
        { type: "WEIGHT", day: "2026-05-10", mean_value: 82.0 },
        { type: "WEIGHT", day: "2026-05-11", mean_value: 82.2 },
      ])
      .mockResolvedValueOnce([{ first_at: new Date(now.getTime() - 86400000) }]);
    FIND_MANY.mockResolvedValueOnce([]) // sys
      .mockResolvedValueOnce([]); // dia

    const result = await buildComprehensiveAggregate("user-pop");
    const weight = result.summaries.WEIGHT;

    expect(weight.count).toBe(42);
    expect(weight.latest).toBe(81.4);
    expect(weight.min).toBe(79.2);
    expect(weight.max).toBe(84.1);
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
    expect(result.dailyByType.WEIGHT).toEqual([
      { day: "2026-05-10", value: 82.0 },
      { day: "2026-05-11", value: 82.2 },
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ first_at: measuredAt }]);
    FIND_MANY.mockResolvedValueOnce([
      { measuredAt, value: 120 },
    ]).mockResolvedValueOnce([{ measuredAt, value: 80 }]);

    const result = await buildComprehensiveAggregate("user-bp");
    expect(result.bpRawRows.sys).toEqual([{ measuredAt, value: 120 }]);
    expect(result.bpRawRows.dia).toEqual([{ measuredAt, value: 80 }]);
  });
});
