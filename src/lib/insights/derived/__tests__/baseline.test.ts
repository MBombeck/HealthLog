import { describe, it, expect, vi, beforeEach } from "vitest";

// Day-mean reads fold per-day aggregates in SQL; the fake folds the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { findMany: vi.fn() } },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn(),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn(),
}));

import {
  median,
  medianAbsoluteDeviation,
  buildBaselineBand,
  computeVitalsBaseline,
} from "../baseline";
import { prisma } from "@/lib/db";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T07:00:00Z");

function dayRow(day: string, mean: number) {
  return {
    bucketStart: new Date(`${day}T00:00:00Z`),
    count: 1,
    mean,
    sd: null,
    slope: null,
    r2: null,
    sumValue: null,
    minValue: mean,
    maxValue: mean,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("pure statistics", () => {
  it("median handles odd + even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("MAD is the median of absolute deviations about the median", () => {
    // values 1,2,3,4,5 → median 3 → |dev| 2,1,0,1,2 → MAD = 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
  });

  it("buildBaselineBand returns a symmetric MAD band", () => {
    const band = buildBaselineBand([50, 52, 54, 56, 58], "PULSE", 3);
    expect(band).not.toBeNull();
    expect(band!.center).toBe(54);
    expect(band!.low).toBeLessThan(band!.center);
    expect(band!.high).toBeGreaterThan(band!.center);
    expect(band!.sampleDays).toBe(5);
    expect(band!.k).toBe(3);
  });

  // A run of identical days has no dispersion at all: the bare MAD band
  // collapsed to one value and every surface read "your usual range is
  // 61–61 bpm", while a reading of 62 counted as outside it.
  it("never collapses to a single value when the days are identical", () => {
    const band = buildBaselineBand(Array(20).fill(61), "RESTING_HEART_RATE");
    expect(band).not.toBeNull();
    expect(band!.center).toBe(61);
    expect(band!.low).toBeLessThan(61);
    expect(band!.high).toBeGreaterThan(61);
    // Distinct at the precision any surface prints a heart rate.
    expect(Math.round(band!.low)).not.toBe(Math.round(band!.high));
    // An ordinary next-day reading sits inside the band, not above it.
    expect(62).toBeLessThanOrEqual(band!.high);
    // The dispersion itself is reported as it is.
    expect(band!.spread).toBe(0);
  });

  it.each([
    ["RESTING_HEART_RATE", 61],
    ["PULSE", 72],
    ["HEART_RATE_VARIABILITY", 45],
    ["RESPIRATORY_RATE", 14],
    ["OXYGEN_SATURATION", 97],
    ["BODY_TEMPERATURE", 36.6],
    ["SKIN_TEMPERATURE", 34.1],
    ["BLOOD_PRESSURE_SYS", 118],
    ["BLOOD_PRESSURE_DIA", 76],
    ["BLOOD_GLUCOSE", 95],
    ["WEIGHT", 80],
    ["VO2_MAX", 42],
    ["ACTIVITY_STEPS", 8000],
  ] as const)(
    "gives %s a band that reads as a range at one decimal",
    (type, value) => {
      const band = buildBaselineBand(Array(10).fill(value), type);
      expect(band!.low.toFixed(1)).not.toBe(band!.high.toFixed(1));
    },
  );

  it("leaves a band wider than the floor exactly as the spread makes it", () => {
    const band = buildBaselineBand([50, 52, 54, 56, 58], "PULSE", 3);
    expect(band!.high - band!.center).toBeCloseTo(band!.spread, 10);
  });

  it("parity: a composed-DAY-bucket series and the raw-DAY series yield the same band", () => {
    // Same per-day means whether they arrive as raw rows or DAY rollups.
    const perDayMeans = [60, 61, 62, 59, 63, 58, 64];
    const fromRaw = buildBaselineBand(perDayMeans, "PULSE", 3);
    const fromRollup = buildBaselineBand([...perDayMeans], "PULSE", 3);
    expect(fromRollup).toEqual(fromRaw);
  });
});

describe("computeVitalsBaseline — ok path (rollup tier)", () => {
  it("returns an ok band from DAY rollups with provenance source DAY", async () => {
    vi.mocked(probeRollupCoverage).mockResolvedValue(
      new Map([["RESTING_HEART_RATE", true]]),
    );
    const rows = [
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
      "2026-05-24",
      "2026-05-25",
      "2026-05-26",
      "2026-05-27",
    ].map((d, i) => dayRow(d, 55 + i));
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });

    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "RESTING_HEART_RATE",
      now: NOW,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.type).toBe("RESTING_HEART_RATE");
      expect(result.provenance.source).toBe("DAY");
      expect(result.coverage.historyDays).toBe(8);
      expect(result.confidence.score).toBeGreaterThan(0);
      // The trailing per-day mean series backs the inline sparkline: one
      // point per contributing day, oldest → newest (55..62).
      expect(result.value.series).toEqual([55, 56, 57, 58, 59, 60, 61, 62]);
    }
    // rollup-covered path must not touch raw SQL
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it("caps the sparkline series to the last 30 points on a long window", async () => {
    vi.mocked(probeRollupCoverage).mockResolvedValue(
      new Map([["RESTING_HEART_RATE", true]]),
    );
    // 40 days of DAY rollups — the series must trail to the last 30, newest last.
    const rows = Array.from({ length: 40 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);
      return dayRow(d, 50 + i);
    });
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });

    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "RESTING_HEART_RATE",
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.series).toHaveLength(30);
      // The newest day's mean is the final series point (50 + 39 = 89).
      expect(result.value.series.at(-1)).toBe(89);
    }
  });
});

describe("computeVitalsBaseline — coverage-miss live fallback", () => {
  it("falls back to raw rows and reports provenance source live", async () => {
    // coverage says no buckets for this type → live read
    vi.mocked(probeRollupCoverage).mockResolvedValue(
      new Map([["RESTING_HEART_RATE", false]]),
    );
    const raw = [
      "2026-05-20",
      "2026-05-21",
      "2026-05-22",
      "2026-05-23",
      "2026-05-24",
      "2026-05-25",
      "2026-05-26",
    ].map((d, i) => ({
      value: 60 + i,
      measuredAt: new Date(`${d}T08:00:00Z`),
    }));
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(raw as never);

    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "RESTING_HEART_RATE",
      now: NOW,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.provenance.source).toBe("live");
      expect(result.coverage.historyDays).toBe(7);
    }
    expect(readBestGranularityRollups).not.toHaveBeenCalled();
    expect(prisma.measurement.findMany).toHaveBeenCalledTimes(1);
  });

  it("rollup-covered but window resolves coarser → live fallback keeps spread DAY-native", async () => {
    vi.mocked(probeRollupCoverage).mockResolvedValue(
      new Map([["RESTING_HEART_RATE", true]]),
    );
    // resolved at MONTH (coarse) — engine must not band from it
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "MONTH",
      rows: [dayRow("2026-04-01", 55)],
    });
    const raw = Array.from({ length: 7 }, (_, i) => ({
      value: 58 + i,
      measuredAt: new Date(`2026-05-2${i}T08:00:00Z`),
    }));
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(raw as never);

    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "RESTING_HEART_RATE",
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.provenance.source).toBe("live");
  });
});

describe("computeVitalsBaseline — insufficient paths", () => {
  it("no data at all → insufficient, source none", async () => {
    vi.mocked(probeRollupCoverage).mockResolvedValue(new Map());
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);

    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "RESTING_HEART_RATE",
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_readings_in_window");
      expect(result.provenance.source).toBe("none");
      expect(result.coverage.historyDays).toBe(0);
    }
  });

  it("below the 7-day floor → insufficient, value-less, but coverage shows progress", async () => {
    vi.mocked(probeRollupCoverage).mockResolvedValue(
      new Map([["RESTING_HEART_RATE", true]]),
    );
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows: [
        dayRow("2026-05-25", 55),
        dayRow("2026-05-26", 56),
        dayRow("2026-05-27", 57),
      ],
    });

    const result = await computeVitalsBaseline("u1", PROFILE, {
      type: "RESTING_HEART_RATE",
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("insufficient_history_for_band");
      expect(result.coverage.historyDays).toBe(3);
    }
  });
});
