import { describe, it, expect, vi, beforeEach } from "vitest";

// The day reads pick each day's ladder-winning source; the user's ladder
// blob is read once per call. No account here has one, so the default ladders apply.
vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  loadUserSourcePriority: async () => null,
}));

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
  fitOls,
  predictionIntervalHalfWidth,
  computeTrajectory,
  TRAJECTORY_MIN_HISTORY_DAYS,
} from "../trajectory";
import { prisma } from "@/lib/db";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
// `now` sits just after the last seeded day so the window-anchored reader
// keeps every seeded day in-window (the staleness gate stays satisfied).
const NOW = new Date("2026-06-02T07:00:00Z");
const TYPE = "WEIGHT";

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

/** Build `count` consecutive DAY rows ending at `2026-06-01`, mean = f(i). */
function seedDays(count: number, f: (i: number) => number) {
  const end = new Date("2026-06-01T00:00:00Z").getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(end - (count - 1 - i) * dayMs)
      .toISOString()
      .slice(0, 10);
    rows.push(dayRow(day, f(i)));
  }
  return rows;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(probeRollupCoverage).mockResolvedValue(new Map([[TYPE, true]]));
});

describe("pure OLS + prediction interval", () => {
  it("recovers the slope + intercept of a clean line (R² = 1)", () => {
    // y = 80 + 0.5x over x = 0..19.
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = xs.map((x) => 80 + 0.5 * x);
    const fit = fitOls(xs, ys);
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(0.5, 6);
    expect(fit!.intercept).toBeCloseTo(80, 6);
    expect(fit!.r2).toBeCloseTo(1, 6);
    // A perfect fit still carries a non-negative (here ~0) residual SE.
    expect(fit!.residualStdError).toBeCloseTo(0, 6);
  });

  it("returns null on a degenerate fit (< 3 points or zero variance in x)", () => {
    expect(fitOls([0, 1], [1, 2])).toBeNull();
    expect(fitOls([5, 5, 5], [1, 2, 3])).toBeNull();
  });

  it("prediction band widens monotonically as x leaves the data centre", () => {
    // Noisy enough to carry a positive residual SE so the band has width.
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const ys = xs.map((x) => 80 + 0.5 * x + (x % 2 === 0 ? 1 : -1));
    const fit = fitOls(xs, ys)!;
    const near = predictionIntervalHalfWidth(fit, fit.meanX); // at the centre
    const mid = predictionIntervalHalfWidth(fit, 25);
    const far = predictionIntervalHalfWidth(fit, 35);
    expect(near).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(near);
    expect(far).toBeGreaterThan(mid);
  });
});

describe("computeTrajectory — ok path", () => {
  it("projects a seeded upward trend with a widening band", async () => {
    // 20 days of a clean +0.2/day trend with a touch of noise so the fit is
    // strong (R² well over the floor) but the residual SE is non-zero.
    const rows = seedDays(20, (i) => 80 + 0.2 * i + (i % 2 === 0 ? 0.1 : -0.1));
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });

    const result = await computeTrajectory("u1", PROFILE, {
      type: TYPE,
      horizonDays: 14,
      now: NOW,
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const v = result.value;
    expect(v.direction).toBe("up");
    expect(v.slopePerDay).toBeCloseTo(0.2, 1);
    expect(v.r2).toBeGreaterThan(0.9);
    expect(v.method).toBe("ols");
    expect(v.horizonDays).toBe(14);
    expect(v.projection).toHaveLength(14);
    expect(result.provenance.source).toBe("DAY");

    // The projected line keeps rising over the horizon.
    const first = v.projection[0];
    const last = v.projection[v.projection.length - 1];
    expect(last.projected).toBeGreaterThan(first.projected);

    // The honesty signal: the band fans out — the last horizon point is
    // strictly wider than the first.
    const firstWidth = first.bandHigh - first.bandLow;
    const lastWidth = last.bandHigh - last.bandLow;
    expect(firstWidth).toBeGreaterThan(0);
    expect(lastWidth).toBeGreaterThan(firstWidth);

    // The band brackets the projected value at every point.
    for (const p of v.projection) {
      expect(p.bandLow).toBeLessThan(p.projected);
      expect(p.bandHigh).toBeGreaterThan(p.projected);
    }
  });

  it("clamps the horizon to the 14-day ceiling", async () => {
    const rows = seedDays(20, (i) => 80 + 0.2 * i + (i % 2 === 0 ? 0.1 : -0.1));
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });
    const result = await computeTrajectory("u1", PROFILE, {
      type: TYPE,
      horizonDays: 90,
      now: NOW,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.horizonDays).toBe(14);
      expect(result.value.projection).toHaveLength(14);
    }
  });
});

describe("computeTrajectory — insufficient gates (no weak line)", () => {
  it("no data in window → insufficient (source none)", async () => {
    vi.mocked(probeRollupCoverage).mockResolvedValue(new Map());
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const result = await computeTrajectory("u1", PROFILE, {
      type: TYPE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_readings_in_window");
      expect(result.provenance.source).toBe("none");
    }
  });

  it("too few history days → insufficient, never a line", async () => {
    // One under the floor → gated.
    const rows = seedDays(TRAJECTORY_MIN_HISTORY_DAYS - 1, (i) => 80 + 0.2 * i);
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });
    const result = await computeTrajectory("u1", PROFILE, {
      type: TYPE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("insufficient_history_for_projection");
    }
  });

  it("weak fit (R² below the floor) → insufficient, never a line", async () => {
    // A flat-with-alternating-noise series: no real trend → low R².
    const rows = seedDays(20, (i) => 80 + (i % 2 === 0 ? 3 : -3));
    vi.mocked(readBestGranularityRollups).mockResolvedValue({
      granularity: "DAY",
      rows,
    });
    const result = await computeTrajectory("u1", PROFILE, {
      type: TYPE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("insufficient_fit_for_projection");
    }
  });

  it("stale series (all points outside the now-anchored window) → insufficient", async () => {
    // Coverage misses → live read; rows are months old, so the
    // window-anchored live read returns nothing in-window.
    vi.mocked(probeRollupCoverage).mockResolvedValue(new Map([[TYPE, false]]));
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const result = await computeTrajectory("u1", PROFILE, {
      type: TYPE,
      windowDays: 30,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_readings_in_window");
    }
  });
});
