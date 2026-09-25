/**
 * v1.15.20 — supply-runway estimate behind the detail Übersicht's
 * "lasts about N more days" line. Pure helpers, no render needed.
 */

import { describe, it, expect } from "vitest";

import {
  cadenceIntervalDays,
  classifyLowStockState,
  effectiveUnitsPerDose,
  estimateDailyDoseCount,
  estimateDailyUnitsCount,
  estimateRunwayDays,
  estimateUnitsRunwayDays,
  lowStockTriggerDays,
  supplyRunwayDates,
  type RunwaySchedule,
} from "@/components/medications/detail/supply-runway";

function schedule(partial: Partial<RunwaySchedule>): RunwaySchedule {
  return {
    windowStart: "08:00",
    daysOfWeek: null,
    ...partial,
  };
}

describe("estimateDailyDoseCount", () => {
  it("counts a plain daily schedule as its times-of-day per day", () => {
    expect(
      estimateDailyDoseCount([schedule({ timesOfDay: ["08:00", "20:00"] })]),
    ).toBe(2);
  });

  it("falls back to one dose per day when timesOfDay is absent", () => {
    expect(estimateDailyDoseCount([schedule({})])).toBe(1);
  });

  it("scales a rolling interval down (one dose every N days)", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["09:00"], rollingIntervalDays: 7 }),
      ]),
    ).toBeCloseTo(1 / 7);
  });

  it("scales weekday picks against the 7-day week", () => {
    // Mon/Wed/Fri → 3 doses per 7 days.
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], daysOfWeek: "1,3,5" }),
      ]),
    ).toBeCloseTo(3 / 7);
  });

  it("honours the encoded interval-weeks cadence", () => {
    // Every 2nd week on one weekday → 1 dose per 14 days.
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], daysOfWeek: "i2;1" }),
      ]),
    ).toBeCloseTo(1 / 14);
  });

  it("approximates a monthly RRULE at one dose per 30 days", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], rrule: "FREQ=MONTHLY;BYMONTHDAY=1" }),
      ]),
    ).toBeCloseTo(1 / 30);
  });

  it("treats a once-weekly RRULE as one dose per 7 days", () => {
    // FREQ=WEEKLY;BYDAY=MO is the modern once-weekly injection encoding;
    // it must NOT fall through to the daysPerWeek=7 legacy branch.
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], rrule: "FREQ=WEEKLY;BYDAY=MO" }),
      ]),
    ).toBeCloseTo(1 / 7);
  });

  it("halves a bi-weekly RRULE via INTERVAL=2 (one dose per 14 days)", () => {
    expect(
      estimateDailyDoseCount([
        schedule({
          timesOfDay: ["08:00"],
          rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
        }),
      ]),
    ).toBeCloseTo(1 / 14);
  });

  it("counts each BYDAY pick on a weekly RRULE (Mon+Thu → 2 per 7 days)", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], rrule: "FREQ=WEEKLY;BYDAY=MO,TH" }),
      ]),
    ).toBeCloseTo(2 / 7);
  });

  it("defaults a weekly RRULE with no BYDAY to one pick per week", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"], rrule: "FREQ=WEEKLY" }),
      ]),
    ).toBeCloseTo(1 / 7);
  });

  it("sums across multiple schedules", () => {
    expect(
      estimateDailyDoseCount([
        schedule({ timesOfDay: ["08:00"] }),
        schedule({ timesOfDay: ["20:00"] }),
      ]),
    ).toBe(2);
  });
});

describe("estimateRunwayDays", () => {
  it("divides the remaining doses by the daily consumption", () => {
    expect(
      estimateRunwayDays(14, [schedule({ timesOfDay: ["08:00", "20:00"] })]),
    ).toBe(7);
  });

  it("floors to whole days", () => {
    expect(
      estimateRunwayDays(5, [schedule({ timesOfDay: ["08:00", "20:00"] })]),
    ).toBe(2);
  });

  it("returns null when no supply remains", () => {
    expect(estimateRunwayDays(0, [schedule({})])).toBeNull();
  });

  it("returns null when no schedule consumes doses", () => {
    expect(estimateRunwayDays(10, [])).toBeNull();
  });

  it("covers the weekly injection case (rolling 7-day pen)", () => {
    // 4 doses left on a once-a-week injection → ~28 days.
    expect(
      estimateRunwayDays(4, [
        schedule({ timesOfDay: ["09:00"], rollingIntervalDays: 7 }),
      ]),
    ).toBe(28);
  });
});

describe("estimateRunwayDays — v1.16.10 multi-unit doses", () => {
  it("runs off the dose-derived count: floor(units / unitsPerDose) before dividing by daily consumption", () => {
    // 9 units at 2 units per dose → floor(9 / 2) = 4 doses; a daily
    // single-dose schedule then reads 4 days of runway. The call sites
    // (Übersicht supply row, Bestand summary) derive the dose count this
    // way before handing it to the estimator.
    const unitsRemaining = 9;
    const unitsPerDose = 2;
    const dosesRemaining = Math.floor(unitsRemaining / unitsPerDose);
    expect(
      estimateRunwayDays(dosesRemaining, [schedule({ timesOfDay: ["08:00"] })]),
    ).toBe(4);
  });

  it("a partial dose's worth of units never counts as a day", () => {
    // 1 unit at 2 units per dose is not a dose → no runway.
    expect(
      estimateRunwayDays(Math.floor(1 / 2), [
        schedule({ timesOfDay: ["08:00"] }),
      ]),
    ).toBeNull();
  });
});

describe("cadenceIntervalDays — v1.17.0", () => {
  it("is ≈1 for a daily med", () => {
    expect(cadenceIntervalDays([schedule({ timesOfDay: ["08:00"] })])).toBe(1);
  });

  it("is ≈7 for a weekly injection", () => {
    expect(
      cadenceIntervalDays([
        schedule({ timesOfDay: ["09:00"], rollingIntervalDays: 7 }),
      ]),
    ).toBe(7);
  });

  it("is null for a schedule-less (as-needed) medication", () => {
    expect(cadenceIntervalDays([])).toBeNull();
  });
});

describe("lowStockTriggerDays — v1.17.0", () => {
  const daily = [schedule({ timesOfDay: ["08:00"] })];
  const weekly = [schedule({ timesOfDay: ["09:00"], rollingIntervalDays: 7 })];

  it("keeps a daily med with no lead at the bare floor (never shrinks)", () => {
    expect(
      lowStockTriggerDays({
        lowStockRunwayDays: 7,
        leadDays: 0,
        schedules: daily,
      }),
    ).toBe(7);
  });

  it("widens a weekly med to cover the reorder lead PLUS one dose-interval", () => {
    // max(7, 10 lead + 7 interval) = 17 → fires ~10 days before the last dose.
    expect(
      lowStockTriggerDays({
        lowStockRunwayDays: 7,
        leadDays: 10,
        schedules: weekly,
      }),
    ).toBe(17);
  });

  it("never drops below the user floor even when lead + cadence are small", () => {
    expect(
      lowStockTriggerDays({
        lowStockRunwayDays: 14,
        leadDays: 2,
        schedules: daily,
      }),
    ).toBe(14);
  });

  it("falls back to the bare floor for a schedule-less medication", () => {
    expect(
      lowStockTriggerDays({
        lowStockRunwayDays: 7,
        leadDays: 10,
        schedules: [],
      }),
    ).toBe(7);
  });
});

describe("classifyLowStockState — v1.17.0", () => {
  const weekly = [schedule({ timesOfDay: ["09:00"], rollingIntervalDays: 7 })];

  it("returns null when comfortably above the trigger", () => {
    expect(
      classifyLowStockState({
        runwayDays: 20,
        triggerDays: 17,
        schedules: weekly,
      }),
    ).toBeNull();
  });

  it("flags running_low within the trigger but above one cadence interval", () => {
    expect(
      classifyLowStockState({
        runwayDays: 14,
        triggerDays: 17,
        schedules: weekly,
      }),
    ).toBe("running_low");
  });

  it("flags last_dose at one cadence interval", () => {
    expect(
      classifyLowStockState({
        runwayDays: 7,
        triggerDays: 17,
        schedules: weekly,
      }),
    ).toBe("last_dose");
  });
});

describe("supplyRunwayDates — v1.17.0", () => {
  const today = new Date(Date.UTC(2026, 5, 1)); // 1 Jun 2026

  it("computes runsOutOn = today + runway and reorderBy = runsOutOn − lead", () => {
    const { runsOutOn, reorderBy } = supplyRunwayDates({
      today,
      runwayDays: 14,
      leadDays: 10,
    });
    expect(runsOutOn.toISOString().slice(0, 10)).toBe("2026-06-15");
    expect(reorderBy.toISOString().slice(0, 10)).toBe("2026-06-05");
  });

  it("clamps reorderBy to today when the lead pushes it into the past", () => {
    const { reorderBy } = supplyRunwayDates({
      today,
      runwayDays: 3,
      leadDays: 10,
    });
    expect(reorderBy.toISOString().slice(0, 10)).toBe("2026-06-01");
  });
});

// v1.37.19 (iOS #25 parity) — slot-aware burn rate.
//
// Watched red: with `estimateDailyUnitsCount` ignoring per-slot
// `unitsPerDose` (the pre-fix behaviour — dose rate × medication-level
// units only), the mixed-dose case below computes 2 units/day instead of
// 1.5 and both the effective-units and the runway assertions fail.
describe("slot-aware units math (#219 parity)", () => {
  const wholeMorning = schedule({ timesOfDay: ["08:00"], unitsPerDose: 1 });
  const halfNoon = schedule({ timesOfDay: ["12:00"], unitsPerDose: 0.5 });

  it("weights each slot's own unitsPerDose by its cadence share", () => {
    // 1 unit + 0.5 unit per day = 1.5 units/day.
    expect(estimateDailyUnitsCount([wholeMorning, halfNoon], 1)).toBeCloseTo(
      1.5,
    );
  });

  it("inherits the medication level for a NULL per-slot value", () => {
    expect(
      estimateDailyUnitsCount(
        [schedule({ timesOfDay: ["08:00"], unitsPerDose: null }), halfNoon],
        2,
      ),
    ).toBeCloseTo(2.5);
  });

  it("derives the schedule-weighted average units per dose", () => {
    // 1.5 units over 2 doses per day → 0.75 units per dose.
    expect(effectiveUnitsPerDose([wholeMorning, halfNoon], 1)).toBeCloseTo(
      0.75,
    );
  });

  it("falls back to the medication level with no consuming schedule", () => {
    expect(effectiveUnitsPerDose([], 2)).toBe(2);
    expect(effectiveUnitsPerDose([], 0)).toBe(1);
  });

  it("projects the units runway under the slot-aware rate", () => {
    // 15 units at 1.5 units/day → 10 days.
    expect(estimateUnitsRunwayDays(15, [wholeMorning, halfNoon], 1)).toBe(10);
  });

  it("is honest about an exhausted supply (0 days, not null)", () => {
    expect(estimateUnitsRunwayDays(0, [wholeMorning], 1)).toBe(0);
  });

  it("returns null with no consuming cadence", () => {
    expect(estimateUnitsRunwayDays(10, [], 1)).toBeNull();
  });
});

// #1034 — a whole number plus a fraction (1½) and a free decimal (1.2)
// run through the same arithmetic as a whole tablet.
describe("units runway with a mixed units-per-dose value (#1034)", () => {
  const morning = schedule({ timesOfDay: ["08:00"] });
  const evening = schedule({ timesOfDay: ["20:00"] });

  it("burns 1½ units per dose at the medication level", () => {
    // Two doses a day at 1.5 units = 3 units/day; 30 units last 10 days.
    expect(estimateDailyUnitsCount([morning, evening], 1.5)).toBeCloseTo(3);
    expect(estimateUnitsRunwayDays(30, [morning, evening], 1.5)).toBe(10);
    expect(effectiveUnitsPerDose([morning, evening], 1.5)).toBeCloseTo(1.5);
  });

  it("honours a 2¼ per-slot override beside the inherited value", () => {
    const heavy = schedule({ timesOfDay: ["20:00"], unitsPerDose: 2.25 });
    // 1 + 2.25 = 3.25 units/day; 13 units last 4 days.
    expect(estimateDailyUnitsCount([morning, heavy], 1)).toBeCloseTo(3.25);
    expect(estimateUnitsRunwayDays(13, [morning, heavy], 1)).toBe(4);
  });

  it("floors a partial day under a free decimal dose", () => {
    // 1.2 units/day; 10 units cover 8 whole days (8.33…).
    expect(estimateUnitsRunwayDays(10, [morning], 1.2)).toBe(8);
  });
});
