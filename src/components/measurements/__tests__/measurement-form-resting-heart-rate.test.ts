/**
 * The manual-entry form offers the resting heart rate (#1079).
 *
 * Resting heart rate has its own chart and series, separate from spot pulse.
 * A value read off a watch or taken on waking had no row in the form, so it
 * could only be logged as a pulse, which feeds a different chart.
 */
import { describe, it, expect } from "vitest";

import { getUnitForType } from "@/lib/validations/measurement";
import {
  MEASUREMENT_FORM_TYPE_VALUES,
  MEASUREMENT_TYPES,
} from "@/components/measurements/measurement-form-types";
import en from "../../../../messages/en.json";

describe("manual entry of the resting heart rate", () => {
  it("offers it as its own type, next to pulse", () => {
    expect(MEASUREMENT_FORM_TYPE_VALUES).toContain("RESTING_HEART_RATE");
    const values = MEASUREMENT_TYPES.map((t) => t.value);
    expect(values.indexOf("RESTING_HEART_RATE")).toBe(
      values.indexOf("PULSE") + 1,
    );
  });

  it("uses the server's unit and a labelled row", () => {
    const row = MEASUREMENT_TYPES.find((t) => t.value === "RESTING_HEART_RATE");
    expect(row).toBeDefined();
    expect(row && "unit" in row ? row.unit : undefined).toBe(
      getUnitForType("RESTING_HEART_RATE"),
    );
    expect(
      (en as { measurements: Record<string, string> }).measurements
        .typeRestingHeartRate,
    ).toBeTruthy();
  });
});
