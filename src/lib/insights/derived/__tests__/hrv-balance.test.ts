import { describe, it, expect, vi, beforeEach } from "vitest";

const computeVitalsBaseline = vi.fn();
const readDayMeanSeries = vi.fn();
vi.mock("../baseline", () => ({
  computeVitalsBaseline: (...a: unknown[]) => computeVitalsBaseline(...a),
  readDayMeanSeries: (...a: unknown[]) => readDayMeanSeries(...a),
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));

import {
  computeHrvBalance,
  placeHrvBalance,
  recentTrendPoints,
} from "../hrv-balance";

const NOW = new Date("2026-06-02T07:00:00Z");
const PROFILE = { ageYears: 40, sex: "MALE" as const };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC day `daysBack` days before `NOW`. */
function dayBefore(daysBack: number): string {
  return new Date(NOW.getTime() - daysBack * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Build a `readDayMeanSeries` return from a list of DAY means, the last one
 * on NOW's day (or `endsDaysBack` days earlier).
 */
function recentSeries(means: number[], endsDaysBack = 0) {
  return {
    points: means.map((mean, i) => ({
      day: dayBefore(endsDaysBack + means.length - 1 - i),
      mean,
    })),
    source: "DAY" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the recent trend sits on the band center so unrelated tests stay
  // "balanced" unless they override the series.
  readDayMeanSeries.mockResolvedValue(recentSeries([60, 60, 60]));
});

describe("placeHrvBalance", () => {
  it("low below the band floor", () => {
    expect(placeHrvBalance(30, 40, 80)).toBe("low");
  });
  it("balanced inside the band", () => {
    expect(placeHrvBalance(60, 40, 80)).toBe("balanced");
  });
  it("unbalanced above the band ceiling", () => {
    expect(placeHrvBalance(90, 40, 80)).toBe("unbalanced");
  });
});

describe("computeHrvBalance", () => {
  it("passes the baseline insufficient through verbatim", async () => {
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "insufficient",
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 3,
        missing: [],
      },
      provenance: {
        inputs: ["HEART_RATE_VARIABILITY"],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
      reason: "insufficient_history_for_band",
    });
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("insufficient");
    if (r.status === "insufficient") {
      expect(r.reason).toBe("insufficient_history_for_band");
      expect(r.coverage.historyDays).toBe(3);
    }
  });

  it("builds a balanced band when the recent trend sits inside the band", async () => {
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "ok",
      value: {
        type: "HEART_RATE_VARIABILITY",
        center: 60,
        low: 40,
        high: 80,
        spread: 20,
        sampleDays: 21,
        k: 3,
      },
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 21,
        missing: [],
      },
      confidence: { score: 70, band: "medium" },
      provenance: {
        inputs: ["HEART_RATE_VARIABILITY"],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
    });
    // Recent trend right around the center → balanced.
    readDayMeanSeries.mockResolvedValueOnce(recentSeries([58, 62, 60]));
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.band).toBe("balanced");
      expect(r.value.recentAvg).toBeCloseTo(60, 5);
      expect(r.value.baselineLow).toBe(40);
      expect(r.value.baselineHigh).toBe(80);
      expect(r.value.sampleDays).toBe(21);
      // Sparkline series reuses the day-mean read (no extra query).
      expect(r.value.series).toEqual([58, 62, 60]);
    }
  });

  it("flags 'low' when the RECENT trend is suppressed below the band, not the band center", async () => {
    // The band center sits inside [low,high] by construction; the previous
    // implementation read it directly so the recentAvg could never go low.
    // Drive a suppressed recent 7-day trend and assert it places "low".
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "ok",
      value: {
        type: "HEART_RATE_VARIABILITY",
        center: 60,
        low: 40,
        high: 80,
        spread: 20,
        sampleDays: 21,
        k: 3,
      },
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 21,
        missing: [],
      },
      confidence: { score: 70, band: "medium" },
      provenance: {
        inputs: ["HEART_RATE_VARIABILITY"],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
    });
    readDayMeanSeries.mockResolvedValueOnce(recentSeries([30, 28, 32]));
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.band).toBe("low");
      expect(r.value.recentAvg).toBeCloseTo(30, 5);
    }
  });

  it("flags 'unbalanced' when the recent trend runs above the band high edge", async () => {
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "ok",
      value: {
        type: "HEART_RATE_VARIABILITY",
        center: 60,
        low: 40,
        high: 80,
        spread: 20,
        sampleDays: 21,
        k: 3,
      },
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 21,
        missing: [],
      },
      confidence: { score: 70, band: "medium" },
      provenance: {
        inputs: ["HEART_RATE_VARIABILITY"],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
    });
    readDayMeanSeries.mockResolvedValueOnce(recentSeries([95, 100, 98]));
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.band).toBe("unbalanced");
      expect(r.value.recentAvg).toBeGreaterThan(80);
    }
  });

  it("uses only the DAY means of the trailing 7 days for the recent trend", async () => {
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "ok",
      value: {
        type: "HEART_RATE_VARIABILITY",
        center: 60,
        low: 40,
        high: 80,
        spread: 20,
        sampleDays: 21,
        k: 3,
      },
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 21,
        missing: [],
      },
      confidence: { score: 70, band: "medium" },
      provenance: {
        inputs: ["HEART_RATE_VARIABILITY"],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
    });
    // 10 days: the first three (high) must NOT pull the recent mean up — only
    // the last 7 (all ~30) count, so the trend is suppressed → "low".
    readDayMeanSeries.mockResolvedValueOnce(
      recentSeries([90, 90, 90, 30, 30, 30, 30, 30, 30, 30]),
    );
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.recentAvg).toBeCloseTo(30, 5);
      expect(r.value.band).toBe("low");
    }
  });

  it("anchors the recent trend on now, not on the newest data", async () => {
    computeVitalsBaseline.mockResolvedValueOnce({
      status: "ok",
      value: {
        type: "HEART_RATE_VARIABILITY",
        center: 60,
        low: 40,
        high: 80,
        spread: 20,
        sampleDays: 21,
        k: 3,
      },
      coverage: {
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 21,
        missing: [],
      },
      confidence: { score: 70, band: "medium" },
      provenance: {
        inputs: ["HEART_RATE_VARIABILITY"],
        source: "DAY",
        windowDays: 30,
        computedAt: "x",
      },
    });
    // The newest reading is six days old: only that day is inside the
    // trailing week. The six suppressed days before it are not, though they
    // are the last seven day means of the series.
    readDayMeanSeries.mockResolvedValueOnce(
      recentSeries([30, 30, 30, 30, 30, 30, 55], 6),
    );
    const r = await computeHrvBalance("u1", PROFILE, { now: NOW });
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      expect(r.value.recentAvg).toBeCloseTo(55, 5);
      expect(r.value.band).toBe("balanced");
    }
  });
});

describe("recentTrendPoints", () => {
  it("keeps the days after the one the trailing week opens in", () => {
    const points = recentSeries([1, 2, 3, 4, 5, 6, 7, 8, 9]).points;
    expect(recentTrendPoints(points, NOW).map((p) => p.mean)).toEqual([
      3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  it("is empty when nothing landed in the trailing week", () => {
    expect(recentTrendPoints(recentSeries([50, 52], 8).points, NOW)).toEqual(
      [],
    );
  });
});
