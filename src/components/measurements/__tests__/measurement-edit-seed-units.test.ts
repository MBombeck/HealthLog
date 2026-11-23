/**
 * The edit sheet seeds its value in the unit its label names, for every
 * converted type and both unit systems. A metric reader editing a walking
 * distance used to see the stored metres ("8733") under a "km" label, so a
 * small correction typed in the shown unit saved a value a thousand times
 * too large.
 */
import { describe, expect, it } from "vitest";

import type { UnitDisplay } from "@/hooks/use-unit-display";
import {
  applyDisplayTransform,
  getDisplayTransform,
  hasDisplayTransform,
  invertDisplayTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";
import { getUnitForType } from "@/lib/measurements/unit-map";

import { editSeedValue, storedValueFor } from "../list/use-measurement-edit";
import { rowDisplayFor } from "../list/use-measurement-row-display";

/** The hook's sugar over the real transform table, without React. */
function display(preference: UnitPreference) {
  const transformFor = (type: string) => getDisplayTransform(type, preference);
  const unitDisplay: UnitDisplay = {
    preference,
    glucoseUnit: "mg/dL",
    transformFor,
    toDisplay: (type, raw) => applyDisplayTransform(raw, transformFor(type)),
    fromDisplay: (type, shown) =>
      invertDisplayTransform(shown, transformFor(type)),
    toDisplayDelta: (_type, delta) => delta,
    unitFor: (type) => transformFor(type).displayUnit,
    decimalsFor: (type) => transformFor(type).decimals,
    isTransformed: (type) => hasDisplayTransform(type),
  };
  return rowDisplayFor("mg/dL", unitDisplay);
}

const row = (type: string, value: number) => ({
  id: "m1",
  type,
  value,
  unit: getUnitForType(type),
  source: "MANUAL",
  measuredAt: "2026-11-10T08:00:00.000Z",
  notes: null,
});

describe("editSeedValue", () => {
  it("seeds a metric distance in km, not the stored metres", () => {
    const d = display("metric");
    const m = row("WALKING_RUNNING_DISTANCE", 8733);
    expect(d.rowDisplay(m).unit).toBe("km");
    expect(editSeedValue(d, m)).toBe(8.73);
  });

  it("seeds a metric walking speed in km/h", () => {
    const d = display("metric");
    const m = row("WALKING_SPEED", 1.3);
    expect(d.rowDisplay(m).unit).toBe("km/h");
    expect(editSeedValue(d, m)).toBe(4.7);
  });

  it("seeds an imperial distance in miles and weight in pounds", () => {
    const d = display("imperial");
    expect(editSeedValue(d, row("WALKING_RUNNING_DISTANCE", 8733))).toBe(5.43);
    expect(editSeedValue(d, row("WEIGHT", 95.25))).toBe(210);
  });

  it("keeps a metric weight at its stored number", () => {
    expect(editSeedValue(display("metric"), row("WEIGHT", 78.45))).toBe(78.45);
  });

  it("keeps a legacy row's stored value under its stored unit", () => {
    const legacy = { ...row("WALKING_RUNNING_DISTANCE", 5), unit: "km" };
    expect(editSeedValue(display("metric"), legacy)).toBe(5);
  });

  // Every converted type, both systems: the seed is what the row shows, and
  // saving it unchanged lands back on the stored value at the shown grain.
  for (const preference of ["metric", "imperial"] as const) {
    for (const type of [
      "WEIGHT",
      "BODY_TEMPERATURE",
      "WALKING_SPEED",
      "WALKING_RUNNING_DISTANCE",
    ]) {
      it(`round-trips ${type} for a ${preference} reader`, () => {
        const d = display(preference);
        const stored = {
          WEIGHT: 82.3,
          BODY_TEMPERATURE: 36.8,
          WALKING_SPEED: 1.31,
          WALKING_RUNNING_DISTANCE: 8733,
        }[type]!;
        const m = row(type, stored);
        const seed = editSeedValue(d, m);
        expect(seed).toBe(d.rowDisplay(m).value);
        const saved = storedValueFor(d, m, seed);
        // Re-seeding the saved value shows the same number again.
        expect(editSeedValue(d, { ...m, value: saved })).toBe(seed);
        const grain = 1 / d.unitDisplay.transformFor(type).factor;
        expect(Math.abs(saved - stored)).toBeLessThanOrEqual(grain);
      });
    }
  }
});
