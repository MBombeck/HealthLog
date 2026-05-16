/**
 * v1.4.33 C1 — unit-level pin for the slim summaries slice. Heavier
 * integration coverage lives in `tests/integration/analytics-summaries-slice.test.ts`
 * (real Postgres, real `regr_slope`); this file mocks `$queryRaw` so
 * the slope/round/empty contracts are pinned without a container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { computeSummariesSlice } from "../summaries-slice";

const RAW = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  RAW.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("computeSummariesSlice", () => {
  it("returns the empty-summary skeleton when the user has no rows", async () => {
    // Pass 1 (aggregates) returns empty, pass 2 (latest) returns empty.
    RAW.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const result = await computeSummariesSlice("user-1");

    // Every enum option is seeded so consumers can read
    // `summaries.WEIGHT` and get a stable empty shape.
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
    // Both SQL passes fired.
    expect(RAW).toHaveBeenCalledTimes(2);
  });

  it("maps a populated aggregate row into the DataSummary shape", async () => {
    RAW.mockResolvedValueOnce([
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
    ]).mockResolvedValueOnce([
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
    // Slope direction respects the 0.01-units-per-day "stable"
    // threshold the JS helper uses. -0.014 → "down", -0.005 →
    // "stable", 0.001 → "stable".
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
    RAW.mockResolvedValueOnce([
      {
        type: "PULSE",
        count: BigInt(1),
        min_value: 72,
        max_value: 72,
        mean_value: 72,
        avg7: 72,
        avg30: 72,
        // regr_slope returns NULL when n < 2.
        slope7: null,
        r2_7: null,
        slope30: null,
        r2_30: null,
        slope90: null,
        r2_90: null,
      },
    ]).mockResolvedValueOnce([
      { type: "PULSE", value: 72, measured_at: new Date() },
    ]);

    const result = await computeSummariesSlice("user-1");
    expect(result.summaries.PULSE.slope7).toBeNull();
    expect(result.summaries.PULSE.slope30).toBeNull();
    expect(result.summaries.PULSE.slope90).toBeNull();
  });

  // v1.4.34 IW-B — surface the per-type freshness map so the
  // dashboard tile strip can render an "Letzter Wert vor Xd" caption
  // even when the consumer read from the slim slice (the path the
  // tile-strip pre-fetch uses on cold paint).
  it("surfaces lastSeenByType from the DISTINCT ON pass's measured_at", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    RAW.mockResolvedValueOnce([
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
    ]).mockResolvedValueOnce([
      { type: "WEIGHT", value: 82.3, measured_at: tenDaysAgo },
    ]);

    const result = await computeSummariesSlice("user-1");
    const ws = result.lastSeenByType.WEIGHT;
    expect(ws).not.toBeNull();
    expect(ws?.daysAgo).toBeGreaterThanOrEqual(9);
    expect(ws?.daysAgo).toBeLessThanOrEqual(11);
    expect(ws?.lastSeenAt).toBe(tenDaysAgo.toISOString());
    // Types the user never logged report null so call sites can
    // fall through without painting a caption.
    expect(result.lastSeenByType.PULSE).toBeNull();
  });

  it("seeds the latest value from the DISTINCT ON pass per type", async () => {
    RAW.mockResolvedValueOnce([
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
    ]).mockResolvedValueOnce([
      { type: "PULSE", value: 88, measured_at: new Date() },
    ]);

    const result = await computeSummariesSlice("user-1");
    // Latest is NOT max — comes from the row at MAX(measured_at).
    expect(result.summaries.PULSE.latest).toBe(88);
    expect(result.summaries.PULSE.max).toBe(95);
  });
});
