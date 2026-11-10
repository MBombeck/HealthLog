import { describe, expect, it } from "vitest";

import { ketoneFingerstickBatch } from "@/components/measurements/ketone-fingerstick";
import { createBatchMeasurementSchema } from "@/lib/validations/measurement";

const AT = "2026-11-01T08:00:00.000Z";

function batch(
  overrides: Partial<Parameters<typeof ketoneFingerstickBatch>[0]>,
) {
  return ketoneFingerstickBatch({
    ketones: "1.2",
    glucose: "",
    glucoseUnit: "mg/dL",
    glucoseContext: "FASTING",
    measuredAt: AT,
    notes: "",
    ...overrides,
  });
}

describe("ketoneFingerstickBatch", () => {
  it("posts the ketones alone when the meter gave no glucose", () => {
    expect(batch({})).toEqual([
      { type: "BLOOD_KETONES", value: 1.2, measuredAt: AT, notes: undefined },
    ]);
  });

  it("posts the glucose and the ketones with one timestamp", () => {
    const rows = batch({
      glucose: "81",
      ketones: "1,5",
      notes: "after breakfast",
    });
    expect(rows).toEqual([
      {
        type: "BLOOD_GLUCOSE",
        value: 81,
        measuredAt: AT,
        notes: "after breakfast",
        glucoseContext: "FASTING",
      },
      {
        type: "BLOOD_KETONES",
        value: 1.5,
        measuredAt: AT,
        notes: "after breakfast",
      },
    ]);
    // The batch the route validates: the shape the form sends is accepted.
    expect(
      createBatchMeasurementSchema.safeParse({ measurements: rows }).success,
    ).toBe(true);
  });

  it("stores glucose typed in mmol/L as mg/dL", () => {
    const rows = batch({ glucose: "4.5", glucoseUnit: "mmol/L" });
    expect(rows?.[0]).toMatchObject({ type: "BLOOD_GLUCOSE", value: 81 });
  });

  it("refuses a number it cannot read rather than dropping half the pair", () => {
    expect(batch({ ketones: "" })).toBeNull();
    expect(batch({ ketones: "abc" })).toBeNull();
    expect(batch({ glucose: "lots" })).toBeNull();
  });

  it("is refused by the route's schema above the meters' range", () => {
    const rows = batch({ ketones: "12", glucose: "90" });
    expect(
      createBatchMeasurementSchema.safeParse({ measurements: rows }).success,
    ).toBe(false);
  });
});
