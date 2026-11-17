/**
 * v1.44 — the extended correlation channel families: the pure series shapers
 * (intake, alcohol days, workout minutes, training load, overnight room
 * climate) and the engine's per-channel `targets` / `phrasing`, plus the fence
 * that keeps the sensitive channels away from every model-bound surface.
 */
import { describe, expect, it } from "vitest";

import {
  ALCOHOL_CHANNEL_KEY,
  CAFFEINE_CHANNEL_KEY,
  discoverCorrelations,
  HYDRATION_CHANNEL_KEY,
  INDOOR_CLIMATE_TARGETS,
  metricFamily,
  MODEL_FENCED_CHANNELS,
  withoutModelFencedPairs,
  type DailySeriesPoint,
  type NamedSeries,
} from "../correlation-discovery";
import {
  buildAlcoholDailySeries,
  buildNutrientDailySeries,
  buildOvernightClimateSeries,
  buildTrainingLoadSeries,
  buildWorkoutMinutesSeries,
  MAX_MACRONUTRIENT_CHANNELS,
  MAX_MICRONUTRIENT_CHANNELS,
  MIN_ALCOHOL_DAYS,
  MIN_OVERNIGHT_HOURS,
} from "../correlation-series-builders";
import { shiftDateKey } from "@/lib/tz/format";

const DAY0 = "2026-01-01";
const dayN = (n: number) => shiftDateKey(DAY0, n);

function daily(values: number[], from = 0): DailySeriesPoint[] {
  return values.map((value, i) => ({ day: dayN(from + i), value }));
}

describe("buildNutrientDailySeries", () => {
  it("folds sources per day and maps water and caffeine to their channels", () => {
    const out = buildNutrientDailySeries(
      [
        {
          day: dayN(0),
          nutrient: "water",
          amount: 1200,
          source: "APPLE_HEALTH",
        },
        { day: dayN(0), nutrient: "water", amount: 300, source: "MANUAL" },
        {
          day: dayN(1),
          nutrient: "caffeine",
          amount: 95,
          source: "APPLE_HEALTH",
        },
      ],
      { minDays: 20 },
    );
    expect(out.map((s) => s.key)).toEqual([
      HYDRATION_CHANNEL_KEY,
      CAFFEINE_CHANNEL_KEY,
    ]);
    expect(out[0].points).toEqual([{ day: dayN(0), value: 1500 }]);
    expect(out[1].points).toEqual([{ day: dayN(1), value: 95 }]);
  });

  it("admits the most-logged varying micronutrients, capped, never a constant", () => {
    const rows = [];
    // Six varying micronutrients with 30..25 days, one constant with 40.
    const codes = [
      "zinc",
      "iron",
      "magnesium",
      "vitamin_d",
      "selenium",
      "iodine",
    ];
    codes.forEach((code, c) => {
      for (let d = 0; d < 30 - c; d += 1) {
        rows.push({
          day: dayN(d),
          nutrient: code,
          amount: 10 + (d % 3),
          source: "APPLE_HEALTH",
        });
      }
    });
    for (let d = 0; d < 40; d += 1) {
      rows.push({
        day: dayN(d),
        nutrient: "vitamin_c",
        amount: 500,
        source: "APPLE_HEALTH",
      });
    }
    // One varying code below the day floor.
    for (let d = 0; d < 10; d += 1) {
      rows.push({
        day: dayN(d),
        nutrient: "copper",
        amount: d,
        source: "APPLE_HEALTH",
      });
    }
    const keys = buildNutrientDailySeries(rows, { minDays: 20 })
      .map((s) => s.key)
      .slice(2);
    expect(keys).toHaveLength(MAX_MICRONUTRIENT_CHANNELS);
    expect(keys).toEqual([
      "NUTRIENT:zinc",
      "NUTRIENT:iron",
      "NUTRIENT:magnesium",
      "NUTRIENT:vitamin_d",
    ]);
  });

  it("counts only the largest day-total source when a tracker and Apple Health both report", () => {
    const out = buildNutrientDailySeries(
      [
        {
          day: dayN(0),
          nutrient: "water",
          amount: 2000,
          source: "APPLE_HEALTH",
        },
        { day: dayN(0), nutrient: "water", amount: 2100, source: "EXTERNAL" },
        { day: dayN(0), nutrient: "water", amount: 250, source: "MANUAL" },
      ],
      { minDays: 20 },
    );
    expect(out[0].points).toEqual([{ day: dayN(0), value: 2350 }]);
  });

  it("gives the macros their own budget, so they never crowd out the micronutrients, and leaves alcohol out", () => {
    const rows: Array<{
      day: string;
      nutrient: string;
      amount: number;
      source: string;
    }> = [];
    const push = (code: string, days: number) => {
      for (let d = 0; d < days; d += 1) {
        rows.push({
          day: dayN(d),
          nutrient: code,
          amount: 10 + (d % 4),
          source: "EXTERNAL",
        });
      }
    };
    // Six macros logged every day, more than any micronutrient.
    for (const code of [
      "energy",
      "protein",
      "carbohydrates",
      "fat",
      "sugar",
      "fiber",
    ]) {
      push(code, 60);
    }
    push("alcohol", 60);
    for (const code of ["zinc", "iron", "magnesium", "vitamin_d", "selenium"]) {
      push(code, 30);
    }
    const keys = buildNutrientDailySeries(rows, { minDays: 20 })
      .map((s) => s.key)
      .slice(2);
    expect(MAX_MACRONUTRIENT_CHANNELS).toBe(2);
    expect(keys).toEqual([
      "NUTRIENT:iron",
      "NUTRIENT:magnesium",
      "NUTRIENT:selenium",
      "NUTRIENT:vitamin_d",
      "NUTRIENT:carbohydrates",
      "NUTRIENT:energy",
    ]);
    expect(keys).not.toContain("NUTRIENT:alcohol");
  });
});

describe("buildAlcoholDailySeries", () => {
  const at = (n: number, hour = 20) =>
    new Date(`${dayN(n)}T${String(hour).padStart(2, "0")}:00:00.000Z`);

  it("marks a day 1 when any entry is tagged, 0 when entries are untagged", () => {
    const entries = [];
    for (let d = 0; d < 12; d += 1) {
      entries.push({ at: at(d, 9), tagged: false });
      entries.push({ at: at(d, 21), tagged: d % 2 === 0 });
    }
    const out = buildAlcoholDailySeries(entries, "UTC");
    expect(out.key).toBe(ALCOHOL_CHANNEL_KEY);
    expect(out.points).toHaveLength(12);
    expect(out.points.filter((p) => p.value === 1)).toHaveLength(6);
    expect(out.points[0]).toEqual({ day: dayN(0), value: 1 });
    expect(out.points[1]).toEqual({ day: dayN(1), value: 0 });
  });

  it("is empty below the tagged-day floor or with nothing to compare against", () => {
    const few = Array.from({ length: 20 }, (_, d) => ({
      at: at(d),
      tagged: d < MIN_ALCOHOL_DAYS - 1,
    }));
    expect(buildAlcoholDailySeries(few, "UTC").points).toEqual([]);
    const all = Array.from({ length: 20 }, (_, d) => ({
      at: at(d),
      tagged: true,
    }));
    expect(buildAlcoholDailySeries(all, "UTC").points).toEqual([]);
  });
});

describe("buildWorkoutMinutesSeries / buildTrainingLoadSeries", () => {
  it("sums a day's sessions and zero-fills only between the first and last", () => {
    const out = buildWorkoutMinutesSeries(
      [
        { startedAt: new Date(`${dayN(0)}T07:00:00Z`), durationSec: 1800 },
        { startedAt: new Date(`${dayN(0)}T18:00:00Z`), durationSec: 900 },
        { startedAt: new Date(`${dayN(3)}T07:00:00Z`), durationSec: 3600 },
      ],
      "UTC",
    );
    expect(out.points).toEqual([
      { day: dayN(0), value: 45 },
      { day: dayN(1), value: 0 },
      { day: dayN(2), value: 0 },
      { day: dayN(3), value: 60 },
    ]);
  });

  it("keys a session on the person's day, not UTC's", () => {
    const out = buildWorkoutMinutesSeries(
      [{ startedAt: new Date(`${dayN(0)}T23:30:00Z`), durationSec: 600 }],
      "Europe/Berlin",
    );
    expect(out.points).toEqual([{ day: dayN(1), value: 10 }]);
  });

  it("fills a missing strain day with zero impulse", () => {
    const out = buildTrainingLoadSeries([
      { day: dayN(0), dayTrimp: 80 },
      { day: dayN(2), dayTrimp: 40 },
    ]);
    expect(out.points).toEqual([
      { day: dayN(0), value: 80 },
      { day: dayN(1), value: 0 },
      { day: dayN(2), value: 40 },
    ]);
  });
});

describe("buildOvernightClimateSeries", () => {
  it("keys 21:00–07:00 on the waking day, averages hours, drops thin nights", () => {
    const rows = [];
    // Night into day 1: 21–23 on day 0 (600 ppm), 0–4 on day 1 (900 ppm).
    for (const h of [21, 22, 23]) {
      rows.push({ type: "INDOOR_CO2", day: dayN(0), hour: h, mean: 600 });
    }
    for (const h of [0, 1, 2, 3, 4]) {
      rows.push({ type: "INDOOR_CO2", day: dayN(1), hour: h, mean: 900 });
    }
    // Daytime hours never count.
    rows.push({ type: "INDOOR_CO2", day: dayN(1), hour: 12, mean: 5000 });
    // A thin night into day 2.
    for (let h = 0; h < MIN_OVERNIGHT_HOURS - 1; h += 1) {
      rows.push({ type: "INDOOR_CO2", day: dayN(2), hour: h, mean: 700 });
    }
    const [co2, temp] = buildOvernightClimateSeries(
      rows,
      ["INDOOR_CO2", "INDOOR_TEMPERATURE"],
      INDOOR_CLIMATE_TARGETS,
    );
    // (3·600 + 5·900) / 8 = 787.5
    expect(co2.points).toEqual([{ day: dayN(1), value: 787.5 }]);
    expect(co2.lagDays).toBe(0);
    expect(co2.phrasing).toBe("overnight");
    expect(co2.targets).toEqual(["SLEEP_DURATION"]);
    expect(temp.points).toEqual([]);
  });
});

describe("discoverCorrelations — targets and phrasing", () => {
  // 60 days of a behaviour alternating in blocks, an outcome that is an exact
  // linear function of the previous day's behaviour: r = −1 after any
  // detrending, n = 59 lag-joined days.
  const x = Array.from({ length: 60 }, (_, d) => (d % 4 < 2 ? 100 : 300));
  const sleepNextDay = [420, ...x.slice(0, 59).map((v) => 480 - 0.5 * v)];

  it("finds caffeine → next-day sleep with the exact n and r", () => {
    const series: NamedSeries[] = [
      { key: CAFFEINE_CHANNEL_KEY, role: "behaviour", points: daily(x) },
      { key: "SLEEP_DURATION", role: "outcome", points: daily(sleepNextDay) },
    ];
    const result = discoverCorrelations(series, { locale: "en" });
    expect(result.pairsTested).toBe(1);
    const pair = result.discovered[0];
    expect(pair.behaviour).toBe(CAFFEINE_CHANNEL_KEY);
    expect(pair.n).toBe(59);
    expect(pair.r).toBeCloseTo(-1, 9);
    expect(pair.interpretation).toContain("caffeine intake");
  });

  it("tests a targeted channel against its targets only", () => {
    const series: NamedSeries[] = [
      {
        key: "INDOOR_CO2",
        role: "behaviour",
        lagDays: 0,
        phrasing: "overnight",
        targets: INDOOR_CLIMATE_TARGETS,
        points: daily(x),
      },
      {
        key: "SLEEP_DURATION",
        role: "outcome",
        points: daily(x.map((v) => 480 - 0.5 * v)),
      },
      { key: "MOOD", role: "outcome", points: daily(x.map((v) => v / 100)) },
      {
        key: "RESTING_HEART_RATE",
        role: "outcome",
        points: daily(x.map((v) => 50 + v / 50)),
      },
    ];
    const result = discoverCorrelations(series, { locale: "en" });
    expect(result.pairsTested).toBe(1);
    expect(result.discovered).toHaveLength(1);
    const pair = result.discovered[0];
    expect(pair.outcome).toBe("SLEEP_DURATION");
    expect(pair.lagDays).toBe(0);
    expect(pair.n).toBe(60);
    expect(pair.r).toBeCloseTo(-1, 9);
    expect(pair.interpretation).toContain("overnight");
    expect(pair.interpretation).toContain("that night");
  });

  it("names a micronutrient by its catalog name in the reader's language", () => {
    const series: NamedSeries[] = [
      { key: "NUTRIENT:magnesium", role: "behaviour", points: daily(x) },
      { key: "SLEEP_DURATION", role: "outcome", points: daily(sleepNextDay) },
    ];
    const [pair] = discoverCorrelations(series, { locale: "de" }).discovered;
    expect(pair.interpretation).toContain("die Zufuhr von Magnesium");
  });
});

describe("families and the model fence", () => {
  it("puts State of Mind in mood's family and the new families in their own", () => {
    expect(metricFamily("STATE_OF_MIND_VALENCE")).toBe("MOOD");
    expect(metricFamily("INDOOR_CO2")).toBe("INDOOR");
    expect(metricFamily("TRAINING_LOAD")).toBe("TRAINING");
    expect(metricFamily("WORKOUT_MINUTES")).toBe("TRAINING");
    expect(metricFamily("NUTRIENT:zinc")).toBe("NUTRIENTS");
    expect(metricFamily(CAFFEINE_CHANNEL_KEY)).toBe("NUTRIENTS");
  });

  it("drops every pair that touches a fenced channel", () => {
    const pairs = [
      { behaviour: ALCOHOL_CHANNEL_KEY, outcome: "SLEEP_DURATION" },
      { behaviour: "MINDFUL_MINUTES", outcome: "MOOD" },
      { behaviour: "ACTIVITY_STEPS", outcome: "STATE_OF_MIND_VALENCE" },
      { behaviour: CAFFEINE_CHANNEL_KEY, outcome: "SLEEP_DURATION" },
    ];
    expect(withoutModelFencedPairs(pairs)).toEqual([pairs[3]]);
    expect([...MODEL_FENCED_CHANNELS].sort()).toEqual([
      "ALCOHOL",
      "MINDFUL_MINUTES",
      "STATE_OF_MIND_VALENCE",
    ]);
  });
});
