/**
 * The edit sheet refuses an implausible value at the value field, before the
 * request, in the unit the input shows. The server checks the same band and
 * used to be the only one that did: its 422 reached the sheet as the English
 * banner "Validation failed", in every locale, with no field marked.
 */
import { describe, expect, it } from "vitest";

import type { UnitDisplay } from "@/hooks/use-unit-display";
import { getUnitForType } from "@/lib/measurements/unit-map";
import { editValueRange } from "../list/use-measurement-edit";
import { rowDisplayFor } from "../list/use-measurement-row-display";

const KG_PER_LB = 0.45359237;

function display(
  preference: "metric" | "imperial",
  glucose: "mg/dL" | "mmol/L",
) {
  const imperial = preference === "imperial";
  const unitDisplay = {
    preference,
    isTransformed: (type: string) => imperial && type === "WEIGHT",
    toDisplay: (type: string, v: number) =>
      imperial && type === "WEIGHT" ? v / KG_PER_LB : v,
    fromDisplay: (type: string, v: number) =>
      imperial && type === "WEIGHT" ? v * KG_PER_LB : v,
    unitFor: (type: string) =>
      imperial && type === "WEIGHT" ? "lb" : getUnitForType(type),
  } as unknown as UnitDisplay;
  return rowDisplayFor(glucose, unitDisplay);
}

const row = (type: string, unit: string) => ({
  id: "m1",
  type,
  value: 72,
  unit,
  source: "MANUAL",
  measuredAt: "2026-11-10T08:00:00.000Z",
  notes: null,
});

describe("editValueRange", () => {
  it("names the band in the stored unit for a metric reader", () => {
    expect(
      editValueRange(display("metric", "mg/dL"), row("WEIGHT", "kg")),
    ).toEqual({ min: 1, max: 500, unit: "kg" });
  });

  it("names it in pounds for an imperial reader, who types pounds", () => {
    const range = editValueRange(
      display("imperial", "mg/dL"),
      row("WEIGHT", "kg"),
    );
    expect(range?.unit).toBe("lb");
    expect(range?.max).toBeCloseTo(1102.3, 1);
  });

  it("names it in mmol/L for a glucose edit in mmol/L", () => {
    const range = editValueRange(
      display("metric", "mmol/L"),
      row("BLOOD_GLUCOSE", "mg/dL"),
    );
    expect(range?.unit).toBe("mmol/L");
    expect(range!.max).toBeLessThan(100);
  });

  it("has nothing to say for a type without a band", () => {
    expect(
      editValueRange(display("metric", "mg/dL"), row("NO_SUCH_TYPE", "x")),
    ).toBeNull();
  });
});
