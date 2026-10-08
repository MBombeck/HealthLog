/**
 * The seasonal/trend adjustment and the effective sample size, pinned at the
 * level where the statistics live: one adjusted Pearson per pair.
 *
 * Every random draw is seeded (see `helpers/seeded-series.ts`); no test reads
 * `Math.random`, so each rate below is the same number on every run. The
 * calibration tests are written so that removing either half of the method
 * (the adjustment or the effective n) turns them red; the "without n_eff"
 * case proves the second half is load-bearing, not decoration.
 */
import { describe, expect, it } from "vitest";

import {
  pearson,
  seasonallyAdjustedPearson,
  type DayPair,
} from "../correlations";
import { lagJoin, type DailySeriesPoint } from "../correlation-discovery";
import {
  autocorrelation,
  basisForSpan,
  dayKeyToIndex,
  effectiveSampleSize,
  minFitRows,
  residualise,
  residualisePair,
  SEASONAL_MIN_SPAN_DAYS,
} from "../seasonal-adjust";
import {
  ar1,
  seasonalScenario,
  seededRng,
  type SeasonalScenario,
} from "./helpers/seeded-series";

/** Next-day pairs (temperature on D, systolic on D+1), keyed on D. */
function lagPairs(
  behaviour: DailySeriesPoint[],
  outcome: DailySeriesPoint[],
): DayPair[] {
  const byDay = new Map(outcome.map((p) => [p.day, p.value]));
  const pairs: DayPair[] = [];
  for (const b of behaviour) {
    const next = dayKeyToIndex(b.day) + 1;
    const key = new Date(next * 86_400_000).toISOString().slice(0, 10);
    const y = byDay.get(key);
    if (y !== undefined) pairs.push({ day: b.day, x: b.value, y });
  }
  return pairs;
}

const RUNS = 200;

/** Share of seeded runs whose adjusted p-value falls below 0.05. */
function rejectionRate(
  scenario: SeasonalScenario,
  test: (pairs: DayPair[]) => number | null,
): number {
  let rejected = 0;
  let tested = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const { temperature, systolic } = seasonalScenario(1000 + seed, scenario);
    const p = test(lagPairs(temperature, systolic));
    if (p === null) continue;
    tested++;
    if (p < 0.05) rejected++;
  }
  expect(tested).toBe(RUNS);
  return rejected / tested;
}

const adjustedP = (pairs: DayPair[]) => {
  const r = seasonallyAdjustedPearson(pairs);
  return r.status === "ok" ? r.pValue : null;
};

/** The method with its second half removed: residuals, but df = n − 2. */
const adjustedWithoutEffectiveN = (pairs: DayPair[]) => {
  const days = pairs.map((p) => dayKeyToIndex(p.day as string));
  const res = residualisePair(
    days,
    pairs.map((p) => p.x),
    pairs.map((p) => p.y),
  );
  if (!res) return null;
  const r = pearson({ xs: res.xs, ys: res.ys });
  return r.status === "ok" ? r.pValue : null;
};

const rawP = (pairs: DayPair[]) => {
  const r = pearson({ xs: pairs.map((p) => p.x), ys: pairs.map((p) => p.y) });
  return r.status === "ok" ? r.pValue : null;
};

describe("residualise", () => {
  it("removes an exact annual wave plus trend to zero", () => {
    const days = Array.from({ length: 200 }, (_, i) => 20_000 + i);
    const values = days.map(
      (d) => 3 + 0.01 * d + 5 * Math.sin((2 * Math.PI * d) / 365.25 + 0.4),
    );
    const res = residualise(days, values, "harmonic");
    expect(res).not.toBeNull();
    for (const v of res!) expect(Math.abs(v)).toBeLessThan(1e-6);
  });

  it("removes only the line under the trend basis", () => {
    const days = Array.from({ length: 60 }, (_, i) => 20_000 + i);
    const values = days.map((d, i) => 2 * d + (i % 2 === 0 ? 1 : -1));
    const res = residualise(days, values, "trend")!;
    // The alternating ±1 survives; the slope is gone.
    expect(Math.abs(res[0] - 1)).toBeLessThan(0.05);
    expect(Math.abs(res[1] + 1)).toBeLessThan(0.05);
  });

  it("refuses to fit fewer than basis size + 10 rows", () => {
    const rows = minFitRows("harmonic") - 1;
    const days = Array.from({ length: rows }, (_, i) => i);
    expect(residualise(days, days.map(Number), "harmonic")).toBeNull();
    expect(minFitRows("trend")).toBe(12);
    expect(minFitRows("harmonic")).toBe(14);
  });

  it("drops to the trend basis under 120 days of span", () => {
    expect(SEASONAL_MIN_SPAN_DAYS).toBe(120);
    expect(basisForSpan(119)).toBe("trend");
    expect(basisForSpan(120)).toBe("harmonic");
  });
});

describe("effectiveSampleSize (Pyper–Peterman)", () => {
  it("keeps about n for two white-noise series", () => {
    const rng = seededRng(3);
    const n = 300;
    const days = Array.from({ length: n }, (_, i) => i);
    const x = Array.from({ length: n }, () => rng.n());
    const y = Array.from({ length: n }, () => rng.n());
    const ne = effectiveSampleSize(days, x, y);
    expect(ne).toBeGreaterThan(0.85 * n);
    expect(ne).toBeLessThanOrEqual(n);
  });

  it("shrinks n well below 0.6·n for two persistent AR(0.7) series", () => {
    const rng = seededRng(4);
    const n = 300;
    const days = Array.from({ length: n }, (_, i) => i);
    const x = ar1(rng, n, 0.7, 1);
    const y = ar1(rng, n, 0.7, 1);
    expect(effectiveSampleSize(days, x, y)).toBeLessThan(0.6 * n);
  });

  it("reads autocorrelation over calendar lags, skipping gaps", () => {
    // Days 0..9 and 20..29: lag-1 pairs exist only inside each block.
    const days = [
      ...Array.from({ length: 10 }, (_, i) => i),
      ...Array.from({ length: 10 }, (_, i) => 20 + i),
    ];
    const values = days.map((d) => (d % 2 === 0 ? 1 : -1));
    expect(autocorrelation(days, values, 1)).toBeCloseTo(-1, 5);
    expect(autocorrelation(days, values, 2)).toBeCloseTo(1, 5);
  });
});

describe("seasonallyAdjustedPearson: the seeded simulation", () => {
  it("rejects the season, not the weather (seed 42, 400 days from 1 January)", () => {
    const { temperature, systolic } = seasonalScenario(42, {
      days: 400,
      startDoy: 0,
    });
    const pairs = lagPairs(temperature, systolic);
    const raw = pearson({
      xs: pairs.map((p) => p.x),
      ys: pairs.map((p) => p.y),
    });
    const adjusted = seasonallyAdjustedPearson(pairs);
    expect(raw.status === "ok" && raw.pValue).toBeLessThan(1e-6);
    expect(adjusted.status).toBe("ok");
    if (adjusted.status !== "ok") return;
    expect(adjusted.basis).toBe("harmonic");
    expect(adjusted.pValue).toBeGreaterThan(0.05);
    expect(adjusted.effectiveN).toBeLessThan(adjusted.n);
  });

  it("holds the false-positive rate near 5 % over 200 seeds of shared season (400 days)", () => {
    const scenario: SeasonalScenario = { days: 400, startDoy: 0 };
    expect(rejectionRate(scenario, rawP)).toBeGreaterThan(0.9);
    expect(rejectionRate(scenario, adjustedP)).toBeLessThanOrEqual(0.06);
    // Remove the effective n and the same residuals reject too often: the
    // serial correlation of the residuals is half of the problem.
    expect(rejectionRate(scenario, adjustedWithoutEffectiveN)).toBeGreaterThan(
      0.08,
    );
  });

  it("holds it on the engine's 180-day window at a random point in the year", () => {
    const scenario: SeasonalScenario = { days: 180, startDoy: "random" };
    expect(rejectionRate(scenario, rawP)).toBeGreaterThan(0.3);
    expect(rejectionRate(scenario, adjustedP)).toBeLessThanOrEqual(0.06);
  });

  it("holds it with 30 % missing days and a three-week gap", () => {
    const scenario: SeasonalScenario = {
      days: 400,
      startDoy: 0,
      missing: 0.3,
      block: 21,
    };
    expect(rejectionRate(scenario, adjustedP)).toBeLessThanOrEqual(0.06);
  });

  it("finds a real next-day effect, with the sign the season was hiding", () => {
    const { temperature, systolic } = seasonalScenario(42, {
      days: 400,
      startDoy: 0,
      beta: 0.7,
    });
    const pairs = lagPairs(temperature, systolic);
    const raw = pearson({
      xs: pairs.map((p) => p.x),
      ys: pairs.map((p) => p.y),
    });
    const adjusted = seasonallyAdjustedPearson(pairs);
    // Raw: warmer days read as LOWER next-day pressure, the season's sign.
    expect(raw.status === "ok" && raw.r).toBeLessThan(0);
    expect(adjusted.status).toBe("ok");
    if (adjusted.status !== "ok") return;
    expect(adjusted.r).toBeGreaterThan(0.15);
    expect(adjusted.pValue).toBeLessThan(0.01);
  });

  it("has the power to find that effect in most runs", () => {
    const power = rejectionRate(
      { days: 400, startDoy: 0, beta: 0.7 },
      adjustedP,
    );
    expect(power).toBeGreaterThan(0.85);
  });

  it("uses the trend-only path on a short series and stays calibrated", () => {
    const scenario: SeasonalScenario = { days: 60, startDoy: 60 };
    const { temperature, systolic } = seasonalScenario(7, scenario);
    const one = seasonallyAdjustedPearson(lagPairs(temperature, systolic));
    expect(one.status === "ok" && one.basis).toBe("trend");
    // 6.0 % over 1 000 seeds; 200 seeds sample it with about ±1.7 points.
    expect(rejectionRate(scenario, adjustedP)).toBeLessThanOrEqual(0.08);
  });

  it("does not test a pair too short to fit, rather than testing it raw", () => {
    const { temperature, systolic } = seasonalScenario(9, {
      days: 12,
      startDoy: 0,
    });
    const pairs = lagPairs(temperature, systolic);
    expect(pairs.length).toBe(11);
    const result = seasonallyAdjustedPearson(pairs, { minPairs: 5 });
    expect(result).toEqual({
      status: "insufficient",
      reason: "too_few_pairs",
      n: 11,
    });
  });

  it("reports no variance for a series that is nothing but trend", () => {
    const pairs: DayPair[] = Array.from({ length: 40 }, (_, i) => ({
      day: 20_000 + i,
      x: 3 + i,
      y: Math.sin(i),
    }));
    expect(seasonallyAdjustedPearson(pairs).status).toBe("insufficient");
  });

  it("agrees with the engine's lag join on which days pair", () => {
    const { temperature, systolic } = seasonalScenario(5, {
      days: 60,
      startDoy: 0,
      missing: 0.2,
    });
    const joined = lagJoin(temperature, systolic, 1);
    const pairs = lagPairs(temperature, systolic);
    expect(pairs.map((p) => p.x)).toEqual(joined.xs);
    expect(pairs.map((p) => p.y)).toEqual(joined.ys);
  });
});
