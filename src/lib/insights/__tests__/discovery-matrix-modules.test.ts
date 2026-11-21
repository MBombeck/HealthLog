/**
 * The discovery matrix leaves out every channel whose module the record
 * switched off, through the surface map, so no correlation statistic is
 * computed over a switched-off module.
 */
import { describe, expect, it, vi } from "vitest";

const pts = [{ day: "2026-09-01", value: 1 }];

vi.mock("@/lib/insights/correlation-channel-series", () => ({
  buildMeasurementDailySeries: vi.fn(),
  fetchMeasurementWindowSeries: vi.fn(),
  fetchMeasurementDailySeriesTiered: vi.fn(
    async (_u: string, _tz: string, _s: Date, types: string[]) => ({
      byType: new Map(types.map((t) => [t, pts])),
      measurementsCapped: false,
      rollupTypes: [],
    }),
  ),
  fetchMoodWindowSeries: vi.fn(async () => ({
    moodDaily: pts,
    moodCapped: false,
  })),
  fetchMoodFactorWindowSeries: vi.fn(async () => ({
    moodDaily: pts,
    moodCapped: false,
    factorSeries: new Map([["FACTOR:work", pts]]),
  })),
  fetchComplianceSeries: vi.fn(async () => ({
    key: "MEDICATION_COMPLIANCE",
    role: "behaviour",
    points: pts,
  })),
  fetchSymptomSeries: vi.fn(async () => ({
    key: "SYMPTOM_SEVERITY",
    role: "outcome",
    points: pts,
  })),
  fetchEnvironmentSeries: vi.fn(async () => [
    { key: "ENV_TEMP_MEAN", role: "behaviour", points: pts },
  ]),
  fetchMovementSeries: vi.fn(async () => [
    { key: "MOVEMENT_AWAY", role: "behaviour", points: pts },
  ]),
  fetchCustomMetricBehaviourSeries: vi.fn(async () => [
    { key: "CUSTOM_METRIC:abc", role: "behaviour", points: pts },
  ]),
  fetchSymptomEventSeries: vi.fn(async () => [
    { key: "SYMPTOM:def1", label: "Aura", role: "outcome", points: pts },
  ]),
  fetchNutrientSeries: vi.fn(async () => [
    { key: "HYDRATION", role: "behaviour", points: pts },
    { key: "CAFFEINE", role: "behaviour", points: pts },
    { key: "NUTRIENT:zinc", role: "behaviour", points: pts },
  ]),
  fetchAlcoholSeries: vi.fn(async () => ({
    key: "ALCOHOL",
    role: "behaviour",
    points: pts,
  })),
  fetchTrainingSeries: vi.fn(async () => [
    { key: "WORKOUT_MINUTES", role: "behaviour", points: pts },
    { key: "TRAINING_LOAD", role: "behaviour", points: pts },
  ]),
  fetchIndoorClimateSeries: vi.fn(async () => [
    {
      key: "INDOOR_CO2",
      role: "behaviour",
      lagDays: 0,
      targets: ["SLEEP_DURATION"],
      points: pts,
    },
  ]),
}));
vi.mock("@/lib/insights/energy-balance-channel", () => ({
  fetchEnergyBalanceSeries: vi.fn(async () => [
    { key: "ENERGY_BALANCE", role: "behaviour", points: pts },
  ]),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(),
}));

import {
  assembleDiscoveryMatrix,
  maskSeriesByModules,
} from "@/lib/insights/discovery-matrix";
import {
  fetchAlcoholSeries,
  fetchEnvironmentSeries,
  fetchIndoorClimateSeries,
  fetchMovementSeries,
  fetchNutrientSeries,
  fetchTrainingSeries,
} from "@/lib/insights/correlation-channel-series";
import { fetchEnergyBalanceSeries } from "@/lib/insights/energy-balance-channel";

const OPTS = {
  tz: "UTC",
  since: new Date("2026-03-01T00:00:00Z"),
  fetchMode: "tiered" as const,
  includeMoodFactors: true,
  modules: {},
};

const keysOf = (series: { key: string }[]) => [
  ...new Set(series.map((s) => s.key)),
];

describe("assembleDiscoveryMatrix — switched-off modules", () => {
  it("keeps every channel with every module on", async () => {
    const { series } = await assembleDiscoveryMatrix("u1", OPTS);
    const keys = keysOf(series);
    for (const key of [
      "MOOD",
      "FACTOR:work",
      "SLEEP_DURATION",
      "BLOOD_GLUCOSE",
      "MEDICATION_COMPLIANCE",
      "SYMPTOM_SEVERITY",
      "ENV_TEMP_MEAN",
      "CUSTOM_METRIC:abc",
      "SYMPTOM:def1",
      "WEIGHT",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("drops each module's channels, and only those, when it is off", async () => {
    const { series, byMetric } = await assembleDiscoveryMatrix("u1", {
      ...OPTS,
      modules: {
        mood: false,
        sleep: false,
        glucose: false,
        medications: false,
        illness: false,
        environment: false,
      },
    });
    const keys = keysOf(series);
    for (const gone of [
      "MOOD",
      "FACTOR:work",
      "SLEEP_DURATION",
      "BLOOD_GLUCOSE",
      "MEDICATION_COMPLIANCE",
      "SYMPTOM_SEVERITY",
      "SYMPTOM:def1",
      "ENV_TEMP_MEAN",
      "MOVEMENT_AWAY",
    ]) {
      expect(keys, gone).not.toContain(gone);
      expect(byMetric.has(gone), gone).toBe(false);
    }
    // Core vitals and custom metrics belong to no module.
    expect(keys).toContain("WEIGHT");
    expect(keys).toContain("BLOOD_PRESSURE_SYS");
    expect(keys).toContain("CUSTOM_METRIC:abc");
  });

  it("scans the nightly RMSSD series as an outcome owned by recovery", async () => {
    const on = await assembleDiscoveryMatrix("u1", OPTS);
    expect(
      on.series.find((s) => s.key === "HRV_RMSSD" && s.role === "outcome"),
    ).toBeDefined();
    const off = await assembleDiscoveryMatrix("u1", {
      ...OPTS,
      modules: { recovery: false },
    });
    const keys = keysOf(off.series);
    expect(keys).not.toContain("HRV_RMSSD");
    // SDNN is a plain vital and stays.
    expect(keys).toContain("HEART_RATE_VARIABILITY");
  });

  it("does not read the weather at all with the environment module off", async () => {
    const read = vi.mocked(fetchEnvironmentSeries);
    read.mockClear();
    await assembleDiscoveryMatrix("u1", {
      ...OPTS,
      modules: { environment: false },
    });
    expect(read).not.toHaveBeenCalled();
    await assembleDiscoveryMatrix("u1", OPTS);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not read the Dawarich days with the environment module off", async () => {
    const read = vi.mocked(fetchMovementSeries);
    read.mockClear();
    await assembleDiscoveryMatrix("u1", {
      ...OPTS,
      modules: { environment: false },
    });
    expect(read).not.toHaveBeenCalled();
    const on = await assembleDiscoveryMatrix("u1", OPTS);
    expect(read).toHaveBeenCalledTimes(1);
    expect(on.series.map((s) => s.key)).toContain("MOVEMENT_AWAY");
  });

  it("drops nothing for AI analysis off", async () => {
    const all = await assembleDiscoveryMatrix("u1", OPTS);
    const off = await assembleDiscoveryMatrix("u1", {
      ...OPTS,
      modules: { insights: false },
    });
    expect(off.series.map((s) => s.key)).toEqual(all.series.map((s) => s.key));
  });
});

describe("assembleDiscoveryMatrix — the extended families (v1.44)", () => {
  const EXTENDED = [
    "HYDRATION",
    "CAFFEINE",
    "NUTRIENT:zinc",
    "ENERGY_BALANCE",
    "ALCOHOL",
    "WORKOUT_MINUTES",
    "TRAINING_LOAD",
    "EXERCISE_MINUTES",
    "STAND_MINUTES",
    "MINDFUL_MINUTES",
    "STATE_OF_MIND_VALENCE",
    "INDOOR_CO2",
  ];

  it("folds every extended family in after the earlier ones", async () => {
    const { series, byMetric } = await assembleDiscoveryMatrix("u1", OPTS);
    const keys = series.map((s) => s.key);
    for (const key of EXTENDED) expect(keys, key).toContain(key);
    // Earlier families keep their place: the first extended key comes after
    // the last person-defined symptom.
    expect(keys.indexOf("EXERCISE_MINUTES")).toBeGreaterThan(
      keys.indexOf("SYMPTOM:def1"),
    );
    expect(series.find((s) => s.key === "STATE_OF_MIND_VALENCE")?.role).toBe(
      "outcome",
    );
    // The extended types feed the scan only, never the narrative's metrics.
    for (const key of ["EXERCISE_MINUTES", "STATE_OF_MIND_VALENCE"]) {
      expect(byMetric.has(key), key).toBe(false);
    }
  });

  it("reads and keeps each family only while its module is on", async () => {
    const reads = [
      fetchNutrientSeries,
      fetchAlcoholSeries,
      fetchTrainingSeries,
      fetchIndoorClimateSeries,
      fetchEnergyBalanceSeries,
    ].map((fn) => vi.mocked(fn));
    for (const read of reads) read.mockClear();
    const { series } = await assembleDiscoveryMatrix("u1", {
      ...OPTS,
      modules: {
        nutrients: false,
        mood: false,
        workouts: false,
        environment: false,
      },
    });
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    const keys = series.map((s) => s.key);
    for (const gone of [
      "HYDRATION",
      "CAFFEINE",
      "NUTRIENT:zinc",
      "ENERGY_BALANCE",
      "ALCOHOL",
      "WORKOUT_MINUTES",
      "TRAINING_LOAD",
      "MINDFUL_MINUTES",
      "STATE_OF_MIND_VALENCE",
      "INDOOR_CO2",
    ]) {
      expect(keys, gone).not.toContain(gone);
    }
    // Exercise and stand minutes are ambient movement and carry no owner.
    expect(keys).toContain("EXERCISE_MINUTES");
    expect(keys).toContain("STAND_MINUTES");
  });
});

describe("maskSeriesByModules", () => {
  it("keeps the fold order of what remains", () => {
    const series = ["WEIGHT", "MOOD", "PULSE", "FACTOR:x"].map((key) => ({
      key,
      role: "behaviour" as const,
      points: pts,
    }));
    expect(
      maskSeriesByModules(series, { mood: false }).map((s) => s.key),
    ).toEqual(["WEIGHT", "PULSE"]);
  });
});
