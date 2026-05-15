import { describe, it, expect } from "vitest";

import { hasMetricData } from "../metric-availability";
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * v1.4.27 F17/F18/F19 — gating helper unit cover.
 *
 * The matrix covers each metric × {has data, no data, missing
 * summary entry, undefined summaries}. The `MOOD` and `MEDICATION`
 * paths read the boolean flags directly; the rest go through the
 * `summaries[METRIC].count` lookup.
 */

function fakeSummary(count: number): DataSummary {
  return {
    count,
    latest: count > 0 ? 1 : null,
    min: null,
    max: null,
    mean: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    slope90: null,
    anomalyCount: 0,
  };
}

const emptyInputs = {
  summaries: {},
  hasMood: false,
  hasMedication: false,
};

describe("hasMetricData", () => {
  it("returns false for PULSE when summaries are undefined", () => {
    expect(
      hasMetricData("PULSE", {
        summaries: undefined,
        hasMood: false,
        hasMedication: false,
      }),
    ).toBe(false);
  });

  it("returns false for PULSE when the summary entry is missing", () => {
    expect(hasMetricData("PULSE", emptyInputs)).toBe(false);
  });

  it("returns false for PULSE when the count is zero", () => {
    expect(
      hasMetricData("PULSE", {
        ...emptyInputs,
        summaries: { PULSE: fakeSummary(0) },
      }),
    ).toBe(false);
  });

  it("returns true for PULSE when the count is one", () => {
    expect(
      hasMetricData("PULSE", {
        ...emptyInputs,
        summaries: { PULSE: fakeSummary(1) },
      }),
    ).toBe(true);
  });

  it("returns true for WEIGHT when the count is positive", () => {
    expect(
      hasMetricData("WEIGHT", {
        ...emptyInputs,
        summaries: { WEIGHT: fakeSummary(42) },
      }),
    ).toBe(true);
  });

  it("derives BMI from WEIGHT count — true when WEIGHT > 0", () => {
    expect(
      hasMetricData("BMI", {
        ...emptyInputs,
        summaries: { WEIGHT: fakeSummary(3) },
      }),
    ).toBe(true);
  });

  it("derives BMI from WEIGHT count — false when WEIGHT is missing", () => {
    expect(hasMetricData("BMI", emptyInputs)).toBe(false);
  });

  it("returns true for BLOOD_PRESSURE_SYS independently of DIA", () => {
    expect(
      hasMetricData("BLOOD_PRESSURE_SYS", {
        ...emptyInputs,
        summaries: { BLOOD_PRESSURE_SYS: fakeSummary(5) },
      }),
    ).toBe(true);
  });

  it("returns false for BLOOD_PRESSURE_DIA when only SYS has data", () => {
    expect(
      hasMetricData("BLOOD_PRESSURE_DIA", {
        ...emptyInputs,
        summaries: { BLOOD_PRESSURE_SYS: fakeSummary(5) },
      }),
    ).toBe(false);
  });

  it("returns true for MOOD when hasMood is true", () => {
    expect(
      hasMetricData("MOOD", {
        summaries: {},
        hasMood: true,
        hasMedication: false,
      }),
    ).toBe(true);
  });

  it("returns false for MOOD when hasMood is false even with a summary", () => {
    expect(
      hasMetricData("MOOD", {
        summaries: { MOOD: fakeSummary(99) },
        hasMood: false,
        hasMedication: false,
      }),
    ).toBe(false);
  });

  it("returns true for MEDICATION when hasMedication is true", () => {
    expect(
      hasMetricData("MEDICATION", {
        summaries: {},
        hasMood: false,
        hasMedication: true,
      }),
    ).toBe(true);
  });

  it("returns false for MEDICATION when hasMedication is false", () => {
    expect(hasMetricData("MEDICATION", emptyInputs)).toBe(false);
  });

  it("returns true for SLEEP_DURATION when the summary count is positive", () => {
    expect(
      hasMetricData("SLEEP_DURATION", {
        ...emptyInputs,
        summaries: { SLEEP_DURATION: fakeSummary(8) },
      }),
    ).toBe(true);
  });

  it("returns true for VO2_MAX when the summary count is positive", () => {
    expect(
      hasMetricData("VO2_MAX", {
        ...emptyInputs,
        summaries: { VO2_MAX: fakeSummary(2) },
      }),
    ).toBe(true);
  });

  it("returns false for VO2_MAX when summaries are undefined", () => {
    expect(
      hasMetricData("VO2_MAX", {
        summaries: undefined,
        hasMood: false,
        hasMedication: false,
      }),
    ).toBe(false);
  });
});
