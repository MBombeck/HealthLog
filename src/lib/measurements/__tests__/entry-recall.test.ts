/**
 * What the add form reads from the person's own history: the types they log
 * by hand, how far a typed value may stray from the last one before the form
 * asks, and which meal context a new glucose reading starts on.
 */
import { describe, expect, it } from "vitest";

import { defaultGlucoseContext } from "../glucose-context-default";
import { deviatesFromLast } from "../last-value-deviation";
import {
  nextUsualType,
  orderByRecent,
  recentEntryTypes,
} from "../recent-entry-types";

const OFFERED = ["BLOOD_PRESSURE", "WEIGHT", "PULSE", "BLOOD_GLUCOSE"];
const at = (iso: string, type: string) => ({ type, measuredAt: iso });

describe("recentEntryTypes", () => {
  it("folds a blood pressure reading and its pulse into one entry type", () => {
    const rows = [
      at("2026-11-21T07:05:00Z", "WEIGHT"),
      at("2026-11-21T07:00:00Z", "PULSE"),
      at("2026-11-21T07:00:00Z", "BLOOD_PRESSURE_SYS"),
      at("2026-11-21T07:00:00Z", "BLOOD_PRESSURE_DIA"),
      at("2026-11-20T07:00:00Z", "WEIGHT"),
    ];
    expect(recentEntryTypes(rows, OFFERED)).toEqual([
      "WEIGHT",
      "BLOOD_PRESSURE",
    ]);
  });

  it("keeps a pulse typed on its own and stops at the cap", () => {
    const rows = [
      at("2026-11-21T09:00:00Z", "PULSE"),
      at("2026-11-21T08:00:00Z", "BLOOD_GLUCOSE"),
      at("2026-11-21T07:00:00Z", "WEIGHT"),
      at("2026-11-21T06:00:00Z", "BLOOD_PRESSURE_SYS"),
    ];
    expect(recentEntryTypes(rows, OFFERED, 3)).toEqual([
      "PULSE",
      "BLOOD_GLUCOSE",
      "WEIGHT",
    ]);
  });

  it("leaves out a type the form does not offer", () => {
    const rows = [at("2026-11-21T07:00:00Z", "ACTIVITY_STEPS")];
    expect(recentEntryTypes(rows, OFFERED)).toEqual([]);
  });
});

describe("orderByRecent and nextUsualType", () => {
  const types = OFFERED.map((value) => ({ value }));
  it("puts the recent types first and keeps the rest in catalogue order", () => {
    expect(
      orderByRecent(types, ["BLOOD_GLUCOSE", "WEIGHT"]).map((t) => t.value),
    ).toEqual(["BLOOD_GLUCOSE", "WEIGHT", "BLOOD_PRESSURE", "PULSE"]);
  });

  it("moves on to the other usual type, or to none", () => {
    expect(nextUsualType(["WEIGHT", "BLOOD_PRESSURE"], "WEIGHT")).toBe(
      "BLOOD_PRESSURE",
    );
    expect(nextUsualType(["WEIGHT", "BLOOD_PRESSURE"], "BLOOD_PRESSURE")).toBe(
      "WEIGHT",
    );
    expect(nextUsualType(["WEIGHT"], "WEIGHT")).toBeNull();
  });
});

describe("deviatesFromLast", () => {
  it("asks about a slipped decimal point on a weight", () => {
    expect(deviatesFromLast("WEIGHT", 8.23, 82.3)).toBe(true);
    expect(deviatesFromLast("WEIGHT", 80.1, 82.3)).toBe(false);
  });

  it("uses absolute points where a percentage would mislead", () => {
    expect(deviatesFromLast("BODY_TEMPERATURE", 38.5, 36.8)).toBe(true);
    expect(deviatesFromLast("BODY_TEMPERATURE", 37.4, 36.8)).toBe(false);
    expect(deviatesFromLast("OXYGEN_SATURATION", 90, 97)).toBe(true);
  });

  it("says nothing without a last reading or for a type that swings", () => {
    expect(deviatesFromLast("WEIGHT", 8, null)).toBe(false);
    expect(deviatesFromLast("ACTIVITY_STEPS", 200, 12000)).toBe(false);
    expect(deviatesFromLast("BLOOD_GLUCOSE", 60, 180)).toBe(false);
  });
});

describe("defaultGlucoseContext", () => {
  const local = (h: number, m = 0) => new Date(2026, 10, 21, h, m);
  it("starts on fasting before ten and after a meal from then on", () => {
    expect(defaultGlucoseContext(local(7, 30))).toBe("FASTING");
    expect(defaultGlucoseContext(local(9, 59))).toBe("FASTING");
    expect(defaultGlucoseContext(local(10))).toBe("POSTPRANDIAL");
    expect(defaultGlucoseContext(local(20))).toBe("POSTPRANDIAL");
  });

  it("follows the person's own context at a similar hour", () => {
    const history = [
      {
        measuredAt: new Date(2026, 10, 19, 21, 0).toISOString(),
        glucoseContext: "BEDTIME",
      },
      {
        measuredAt: new Date(2026, 10, 18, 7, 0).toISOString(),
        glucoseContext: "RANDOM",
      },
    ];
    expect(defaultGlucoseContext(local(22), history)).toBe("BEDTIME");
    expect(defaultGlucoseContext(local(7, 45), history)).toBe("RANDOM");
    // Nothing near noon in the history: the hour decides.
    expect(defaultGlucoseContext(local(12), history)).toBe("POSTPRANDIAL");
  });
});
