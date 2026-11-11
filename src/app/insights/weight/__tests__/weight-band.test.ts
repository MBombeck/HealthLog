/**
 * The weight band belongs to the record on screen. It used to be built from
 * the signed-in person's height, so a parent of 180 cm looking at a child's
 * record saw a healthy band of about 60 to 81 kg behind the child's weights.
 */
import { describe, expect, it } from "vitest";

import { buildWeightRangeFromHeight } from "@/lib/analytics/value-bands";
import { selectWeightBandRange } from "../weight-band";

describe("selectWeightBandRange", () => {
  it("builds the WHO band from the record's height", () => {
    const range = selectWeightBandRange({
      targets: [
        { type: "WEIGHT", range: { min: 25.8, max: 34.7 }, source: "WHO BMI" },
      ],
      profile: { heightCm: 118 },
    });
    expect(range).toEqual(buildWeightRangeFromHeight(118));
  });

  it("paints the record's own target with the override wings", () => {
    const range = selectWeightBandRange({
      targets: [
        { type: "WEIGHT", range: { min: 70, max: 80 }, source: "Custom" },
      ],
      profile: { heightCm: 180 },
    });
    expect(range).toEqual({
      greenMin: 70,
      greenMax: 80,
      orangeMin: 68.5,
      orangeMax: 81.5,
    });
  });

  it("paints nothing without a target or a height, or before the read lands", () => {
    expect(
      selectWeightBandRange({
        targets: [{ type: "WEIGHT", range: null, source: "WHO BMI" }],
        profile: { heightCm: null },
      }),
    ).toBeNull();
    expect(selectWeightBandRange(null)).toBeNull();
  });
});
