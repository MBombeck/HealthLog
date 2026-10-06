import { describe, it, expect } from "vitest";
import {
  resolvePlanMetric,
  buildExperimentOutcome,
  planDayValue,
  type ExperimentOutcomeInput,
} from "@/lib/jobs/coach-plan-review";

describe("resolvePlanMetric", () => {
  it("maps common plan metric strings", () => {
    expect(resolvePlanMetric("SLEEP")?.type).toBe("SLEEP_DURATION");
    expect(resolvePlanMetric("blood pressure")?.type).toBe(
      "BLOOD_PRESSURE_SYS",
    );
    expect(resolvePlanMetric("Steps")?.type).toBe("ACTIVITY_STEPS");
    expect(resolvePlanMetric("WEIGHT")?.valence).toBe("neutral");
    expect(resolvePlanMetric("glucose")?.valence).toBe("lower-better");
    expect(resolvePlanMetric("HRV")?.valence).toBe("higher-better");
  });

  it("returns null for an unreadable metric", () => {
    expect(resolvePlanMetric("mood vibes")).toBeNull();
  });
});

const baseOutcome: ExperimentOutcomeInput = {
  label: "sleep",
  valence: "higher-better",
  beforeMean: 6.0,
  afterMean: 6.6,
  beforeDays: 7,
  afterDays: 7,
  spread: 0.4,
};

describe("buildExperimentOutcome", () => {
  it("reports an improvement as association, never proof", () => {
    const out = buildExperimentOutcome(baseOutcome);
    expect(out.verdict).toBe("improved");
    expect(out.prose).toMatch(/worth keeping/i);
    expect(out.prose).toMatch(/not proven/i);
    expect(out.prose).not.toMatch(/\bis proven\b|it worked|cured/i);
  });

  it("does not cheerlead an adverse trend — routes to the doctor", () => {
    const out = buildExperimentOutcome({
      ...baseOutcome,
      label: "systolic",
      valence: "lower-better",
      beforeMean: 124,
      afterMean: 133,
      spread: 6,
    });
    expect(out.verdict).toBe("worsened");
    expect(out.prose).toMatch(/doctor/i);
    expect(out.prose).not.toMatch(/great job|keep it up|worked/i);
  });

  it("reports a null result honestly", () => {
    const out = buildExperimentOutcome({
      ...baseOutcome,
      afterMean: 6.05,
      spread: 0.4,
    });
    expect(out.verdict).toBe("no_change");
    expect(out.prose).toMatch(/no measurable change/i);
  });

  it("flags insufficient data on a thin side", () => {
    const out = buildExperimentOutcome({ ...baseOutcome, afterDays: 1 });
    expect(out.verdict).toBe("insufficient");
  });

  it("reports a neutral-metric change without a good/bad valence", () => {
    const out = buildExperimentOutcome({
      ...baseOutcome,
      label: "weight",
      valence: "neutral",
      beforeMean: 82,
      afterMean: 80,
      spread: 1,
    });
    expect(out.verdict).toBe("changed");
    expect(out.prose).toMatch(/worth noting, not proven/i);
  });
});

describe("planDayValue", () => {
  const row = {
    day: "2026-10-01",
    segment: 0,
    n: 9,
    sum: 9000,
    min: 0,
    max: 0,
  };

  it("reads a step day as its total, not the mean of its samples", () => {
    expect(planDayValue("ACTIVITY_STEPS", row)).toBe(9000);
  });

  it("reads a level metric as the day's mean", () => {
    expect(planDayValue("WEIGHT", { ...row, sum: 157, n: 2 })).toBe(78.5);
  });

  it("prefers the hourly-weighted mean where the series has one", () => {
    expect(
      planDayValue("RESTING_HEART_RATE", {
        ...row,
        sum: 120,
        n: 2,
        dayMean: 61,
      }),
    ).toBe(61);
  });
});
