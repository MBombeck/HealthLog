import { describe, it, expect, vi, beforeEach } from "vitest";

// Day-mean reads fold per-day aggregates in SQL; the fake folds the mocked
// `measurement.findMany` rows with the same rules.
vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    moodEntry: { findMany: vi.fn().mockResolvedValue([]) },
    // The Sleep Score reads the user's source priority for the canonical
    // writer-dedup ladder; default to no override.
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("UTC"),
}));

import { computeDerivedMetric } from "../dispatch";
import {
  DERIVED_METRIC_IDS,
  getDerivedMetricMeta,
  isDerivedMetricId,
  isVitalsBaselineType,
} from "../registry";

const PROFILE = { ageYears: 40, sex: "MALE" as const };
const NOW = new Date("2026-06-02T07:00:00Z");

beforeEach(() => vi.clearAllMocks());

describe("registry", () => {
  it("exposes every derived metric as implemented", () => {
    expect(getDerivedMetricMeta("VITALS_BASELINE")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("FITNESS_AGE")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("VASCULAR_AGE_DELTA")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("HRV_BALANCE")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("BMI")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("SLEEP_SCORE")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("READINESS")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("COINCIDENT_DEVIATION")?.implemented).toBe(
      true,
    );
    expect(getDerivedMetricMeta("RECOVERY_SCORE")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("STRESS_SCORE")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("STRAIN_SCORE")?.implemented).toBe(true);
    expect(
      getDerivedMetricMeta("WRIST_TEMPERATURE_BASELINE")?.implemented,
    ).toBe(true);
    expect(
      getDerivedMetricMeta("STAIR_ASCENT_SPEED_BASELINE")?.implemented,
    ).toBe(true);
    expect(
      getDerivedMetricMeta("STAIR_DESCENT_SPEED_BASELINE")?.implemented,
    ).toBe(true);
    expect(getDerivedMetricMeta("SIX_MINUTE_WALK_BAND")?.implemented).toBe(
      true,
    );
    expect(getDerivedMetricMeta("TRAJECTORY")?.implemented).toBe(true);
    expect(getDerivedMetricMeta("HEALTH_SCORE")?.implemented).toBe(true);
  });

  it("isDerivedMetricId rejects unknown ids", () => {
    expect(isDerivedMetricId("VITALS_BASELINE")).toBe(true);
    expect(isDerivedMetricId("NOPE")).toBe(false);
  });

  it("isVitalsBaselineType gates the supported set", () => {
    expect(isVitalsBaselineType("RESTING_HEART_RATE")).toBe(true);
    expect(isVitalsBaselineType("STEPS")).toBe(false);
  });

  it("DERIVED_METRIC_IDS is the full closed enum", () => {
    expect(DERIVED_METRIC_IDS).toContain("VITALS_BASELINE");
    expect(DERIVED_METRIC_IDS).toContain("READINESS");
    expect(DERIVED_METRIC_IDS).toContain("HRV_BALANCE");
    expect(DERIVED_METRIC_IDS).toContain("BMI");
    expect(DERIVED_METRIC_IDS).toContain("HEALTH_SCORE");
    expect(DERIVED_METRIC_IDS).toContain("RECOVERY_SCORE");
    expect(DERIVED_METRIC_IDS).toContain("STRESS_SCORE");
    expect(DERIVED_METRIC_IDS).toContain("STRAIN_SCORE");
    expect(DERIVED_METRIC_IDS).toContain("WRIST_TEMPERATURE_BASELINE");
    expect(DERIVED_METRIC_IDS).toContain("STAIR_ASCENT_SPEED_BASELINE");
    expect(DERIVED_METRIC_IDS).toContain("STAIR_DESCENT_SPEED_BASELINE");
    expect(DERIVED_METRIC_IDS).toContain("SIX_MINUTE_WALK_BAND");
    expect(DERIVED_METRIC_IDS).toContain("TRAJECTORY");
    expect(DERIVED_METRIC_IDS).toContain("SAME_TIME_BASELINE");
    expect(DERIVED_METRIC_IDS.length).toBe(18);
  });
});

describe("computeDerivedMetric dispatch", () => {
  it("routes VITALS_BASELINE to the engine (no data → insufficient, not a throw)", async () => {
    const result = await computeDerivedMetric({
      metric: "VITALS_BASELINE",
      userId: "u1",
      profile: PROFILE,
      type: "RESTING_HEART_RATE",
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
  });

  it("routes FITNESS_AGE to its engine (no data → insufficient, not not_implemented)", async () => {
    const result = await computeDerivedMetric({
      metric: "FITNESS_AGE",
      userId: "u1",
      profile: PROFILE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).not.toBe("not_implemented");
    }
  });

  it("routes READINESS to the engine (no data → insufficient, not not_implemented)", async () => {
    const result = await computeDerivedMetric({
      metric: "READINESS",
      userId: "u1",
      profile: PROFILE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("insufficient_components");
    }
  });

  it("routes SLEEP_SCORE to the engine (no sleep → insufficient)", async () => {
    const result = await computeDerivedMetric({
      metric: "SLEEP_SCORE",
      userId: "u1",
      profile: PROFILE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_sleep_in_window");
    }
  });

  it("routes COINCIDENT_DEVIATION to the engine (no bands → insufficient)", async () => {
    const result = await computeDerivedMetric({
      metric: "COINCIDENT_DEVIATION",
      userId: "u1",
      profile: PROFILE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("too_few_banded_vitals");
    }
  });

  it.each([
    "WRIST_TEMPERATURE_BASELINE",
    "STAIR_ASCENT_SPEED_BASELINE",
    "STAIR_DESCENT_SPEED_BASELINE",
  ] as const)(
    "routes %s through the baseline engine (no data → insufficient, not not_implemented)",
    async (metric) => {
      const result = await computeDerivedMetric({
        metric,
        userId: "u1",
        profile: PROFILE,
        now: NOW,
      });
      expect(result.status).toBe("insufficient");
      if (result.status === "insufficient") {
        expect(result.reason).not.toBe("not_implemented");
        // The baseline engine names its fixed type as the missing input.
        expect(result.provenance.inputs).toContain(
          metric.replace("_BASELINE", ""),
        );
      }
    },
  );

  it("routes SIX_MINUTE_WALK_BAND to its engine (no data → insufficient, not not_implemented)", async () => {
    const result = await computeDerivedMetric({
      metric: "SIX_MINUTE_WALK_BAND",
      userId: "u1",
      profile: PROFILE,
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_readings_in_window");
    }
  });

  it("routes TRAJECTORY to its engine (no data → insufficient, not not_implemented)", async () => {
    const result = await computeDerivedMetric({
      metric: "TRAJECTORY",
      userId: "u1",
      profile: PROFILE,
      type: "WEIGHT",
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("no_readings_in_window");
    }
  });

  it("returns unsupported_trajectory_type for a bad TRAJECTORY type", async () => {
    const result = await computeDerivedMetric({
      metric: "TRAJECTORY",
      userId: "u1",
      profile: PROFILE,
      type: "STEPS",
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("unsupported_trajectory_type");
    }
  });

  it("returns unsupported_baseline_type for a bad VITALS_BASELINE type", async () => {
    const result = await computeDerivedMetric({
      metric: "VITALS_BASELINE",
      userId: "u1",
      profile: PROFILE,
      type: "STEPS",
      now: NOW,
    });
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.reason).toBe("unsupported_baseline_type");
    }
  });
});
