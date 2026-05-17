import { describe, expect, it } from "vitest";

import { applyInsightsExcludeFilter } from "../exclude-filter";
import type { AggregatedFeatures } from "../features";

function baseFeatures(): AggregatedFeatures {
  return {
    weight: {
      latest: 82,
      avg7: 82,
      avg30: 82,
      avg90: 82,
      allTimeAvg: 82,
      allTimeMin: 80,
      allTimeMax: 84,
      slope30: 0,
      outlierCount: 0,
      bmi: 25,
      coverage: {
        count: 10,
        spanDays: 30,
        avgDaysBetween: 3,
        oldestDaysAgo: 30,
        newestDaysAgo: 1,
      },
    },
    bloodPressure: {
      avgSys30: 128,
      avgDia30: 82,
      avgSys90: 128,
      avgDia90: 82,
      allTimeAvgSys: 128,
      allTimeAvgDia: 82,
      allTimeMinSys: 110,
      allTimeMaxSys: 145,
      allTimeMinDia: 70,
      allTimeMaxDia: 90,
      slopeSys30: 0,
      slopeDia30: 0,
      sdSys30: 5,
      sdDia30: 3,
      pulsePressure30: 46,
      pctInTarget: 70,
      coverage: {
        count: 10,
        spanDays: 30,
        avgDaysBetween: 3,
        oldestDaysAgo: 30,
        newestDaysAgo: 1,
      },
    },
    medications: [
      {
        name: "Mounjaro",
        dose: "7.5mg",
        category: "GLP1",
        compliance7: 100,
        compliance30: 95,
        compliance90: 92,
        streak: 30,
        missedLast7: 0,
      },
    ],
    context: {
      heightCm: 180,
      hasBpTargets: true,
      totalMeasurements: 100,
      dataSpanDays: 365,
      oldestMeasurementDaysAgo: 365,
      newestMeasurementDaysAgo: 1,
      ageYears: 45,
      gender: "MALE",
    },
  };
}

describe("applyInsightsExcludeFilter", () => {
  it("returns the original payload unchanged when excludeList is empty", () => {
    const f = baseFeatures();
    const out = applyInsightsExcludeFilter(f, []);
    expect(out).toBe(f);
  });

  it("drops weight when 'weight' is excluded", () => {
    const f = baseFeatures();
    const out = applyInsightsExcludeFilter(f, ["weight"]);
    expect(out.weight).toBeUndefined();
    expect(out.bloodPressure).toBeDefined();
  });

  it("drops blood pressure when 'bp' is excluded", () => {
    const f = baseFeatures();
    const out = applyInsightsExcludeFilter(f, ["bp"]);
    expect(out.bloodPressure).toBeUndefined();
    expect(out.weight).toBeDefined();
  });

  it("drops medications when 'medications' or 'compliance' is excluded", () => {
    expect(
      applyInsightsExcludeFilter(baseFeatures(), ["medications"]).medications,
    ).toBeUndefined();
    expect(
      applyInsightsExcludeFilter(baseFeatures(), ["compliance"]).medications,
    ).toBeUndefined();
  });

  it("strips anthropometrics from context without nuking the whole block", () => {
    const out = applyInsightsExcludeFilter(baseFeatures(), ["anthropometrics"]);
    expect(out.context.heightCm).toBeNull();
    expect(out.context.ageYears).toBeNull();
    expect(out.context.gender).toBeNull();
    // The aggregate totals stay — those aren't PII.
    expect(out.context.dataSpanDays).toBe(365);
    expect(out.context.totalMeasurements).toBe(100);
  });

  it("applies multiple exclusions in one pass", () => {
    const out = applyInsightsExcludeFilter(baseFeatures(), [
      "weight",
      "bp",
      "anthropometrics",
    ]);
    expect(out.weight).toBeUndefined();
    expect(out.bloodPressure).toBeUndefined();
    expect(out.context.heightCm).toBeNull();
  });

  it("does not mutate the input", () => {
    const f = baseFeatures();
    applyInsightsExcludeFilter(f, ["weight", "bp", "anthropometrics"]);
    expect(f.weight).toBeDefined();
    expect(f.bloodPressure).toBeDefined();
    expect(f.context.heightCm).toBe(180);
  });

  it("is a no-op for tokens with no mapped feature keys (hrv / resting_hr)", () => {
    const out = applyInsightsExcludeFilter(baseFeatures(), [
      "hrv",
      "resting_hr",
    ]);
    expect(out.weight).toBeDefined();
    expect(out.bloodPressure).toBeDefined();
  });
});
