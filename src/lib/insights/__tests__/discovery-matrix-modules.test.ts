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
  fetchCustomMetricBehaviourSeries: vi.fn(async () => [
    { key: "CUSTOM_METRIC:abc", role: "behaviour", points: pts },
  ]),
  fetchSymptomEventSeries: vi.fn(async () => [
    { key: "SYMPTOM:def1", label: "Aura", role: "outcome", points: pts },
  ]),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(),
}));

import {
  assembleDiscoveryMatrix,
  maskSeriesByModules,
} from "@/lib/insights/discovery-matrix";
import { fetchEnvironmentSeries } from "@/lib/insights/correlation-channel-series";

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
    ]) {
      expect(keys, gone).not.toContain(gone);
      expect(byMetric.has(gone), gone).toBe(false);
    }
    // Core vitals and custom metrics belong to no module.
    expect(keys).toContain("WEIGHT");
    expect(keys).toContain("BLOOD_PRESSURE_SYS");
    expect(keys).toContain("CUSTOM_METRIC:abc");
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

  it("drops nothing for AI analysis off", async () => {
    const all = await assembleDiscoveryMatrix("u1", OPTS);
    const off = await assembleDiscoveryMatrix("u1", {
      ...OPTS,
      modules: { insights: false },
    });
    expect(off.series.map((s) => s.key)).toEqual(all.series.map((s) => s.key));
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
