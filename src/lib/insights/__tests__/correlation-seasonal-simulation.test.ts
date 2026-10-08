/**
 * The discovery engine against the seeded season simulation, end to end.
 *
 * Where `seasonal-adjust.test.ts` pins the statistic, this file pins what a
 * person actually sees: does `discoverCorrelations` SURFACE a finding. It
 * deliberately touches nothing but the engine's long-standing public surface
 * (`discoverCorrelations` over two `NamedSeries`), so the same file runs
 * against the engine before the adjustment existed — and fails there. That is
 * the proof these tests can fail: before v1.42, two series that shared only
 * the calendar surfaced as related in most runs.
 *
 * A finding here is a pair in `discovered`: p < 0.05, BH q ≤ 0.10, and a
 * shrunk effect at or above the 0.2 floor. With one pair per run the BH step
 * is the identity, so the rate is the engine's own false-positive rate.
 */
import { describe, expect, it } from "vitest";

import {
  discoverCorrelations,
  type DailySeriesPoint,
} from "../correlation-discovery";
import {
  seasonalScenario,
  type SeasonalScenario,
} from "./helpers/seeded-series";

const RUNS = 200;

function surfaces(
  temperature: DailySeriesPoint[],
  systolic: DailySeriesPoint[],
): boolean {
  const result = discoverCorrelations(
    [
      { key: "ACTIVITY_STEPS", role: "behaviour", points: temperature },
      { key: "BLOOD_PRESSURE_SYS", role: "outcome", points: systolic },
    ],
    { locale: "en" },
  );
  return result.discovered.length > 0;
}

/** Share of seeded runs in which the engine surfaces the pair. */
function surfacedRate(scenario: SeasonalScenario): number {
  let found = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const { temperature, systolic } = seasonalScenario(5000 + seed, scenario);
    if (surfaces(temperature, systolic)) found++;
  }
  return found / RUNS;
}

describe("discovery engine: series that share only the season", () => {
  it("surfaces no more than ~6 % over 400 days from 1 January", () => {
    expect(surfacedRate({ days: 400, startDoy: 0 })).toBeLessThanOrEqual(0.06);
  });

  it("surfaces no more than ~6 % on the 180-day window, any time of year", () => {
    expect(surfacedRate({ days: 180, startDoy: "random" })).toBeLessThanOrEqual(
      0.06,
    );
  });

  it("surfaces no more than ~6 % over a 180-day spring (rising heat, falling pressure)", () => {
    expect(surfacedRate({ days: 180, startDoy: 32 })).toBeLessThanOrEqual(0.06);
  });

  it("surfaces no more than ~8 % on a short 60-day series (trend-only path)", () => {
    // Under 120 days only the trend is removed. The effective-n estimate is
    // noisier on 59 pairs: over 1 000 seeds this scenario surfaces 6.0 %, and
    // 200 seeds sample that with about ±1.7 points, so the bound sits at the
    // research plan's 8 % rather than at the long-series 6 %.
    expect(surfacedRate({ days: 60, startDoy: 60 })).toBeLessThanOrEqual(0.08);
  });
});

describe("discovery engine: a real next-day effect under the season", () => {
  it("finds it in most runs over 180 days", () => {
    // beta 1.5 mmHg per K of anomaly: r ≈ 0.5 on the residuals.
    expect(
      surfacedRate({ days: 180, startDoy: 32, beta: 1.5 }),
    ).toBeGreaterThan(0.8);
  });

  it("finds it in most runs over 400 days", () => {
    expect(surfacedRate({ days: 400, startDoy: 0, beta: 1.5 })).toBeGreaterThan(
      0.9,
    );
  });
});
