/**
 * The low-stock trigger the medication answers publish resolved
 * (`lowStockTriggerDays`), so a client compares `runwayDays` with it instead
 * of re-deriving the lead and the cadence.
 */
import { describe, expect, it } from "vitest";

import { resolvedLowStockTriggerDays } from "@/lib/medications/low-stock-trigger";
import type { RunwaySchedule } from "@/lib/medications/supply-runway";

const daily: RunwaySchedule[] = [
  { windowStart: "08:00", daysOfWeek: null, timesOfDay: ["08:00"] },
];
const weekly: RunwaySchedule[] = [
  {
    windowStart: "09:00",
    daysOfWeek: null,
    timesOfDay: ["09:00"],
    rollingIntervalDays: 7,
  },
];

function prefs(medication: Record<string, unknown>) {
  return { medication };
}

describe("resolvedLowStockTriggerDays", () => {
  it("adds the account lead and one dose interval when that is longer than the floor", () => {
    // max(7, 10 + 7) for a weekly injection.
    expect(
      resolvedLowStockTriggerDays({
        notificationPrefs: prefs({
          lowStockRunwayDays: 7,
          reorderLeadDays: 10,
        }),
        reorderLeadDays: null,
        schedules: weekly,
      }),
    ).toBe(17);
  });

  it("puts the medication's own lead over the account default", () => {
    expect(
      resolvedLowStockTriggerDays({
        notificationPrefs: prefs({
          lowStockRunwayDays: 7,
          reorderLeadDays: 10,
        }),
        reorderLeadDays: 2,
        schedules: weekly,
      }),
    ).toBe(9);
  });

  it("keeps the floor when lead and interval are shorter", () => {
    expect(
      resolvedLowStockTriggerDays({
        notificationPrefs: prefs({
          lowStockRunwayDays: 14,
          reorderLeadDays: 2,
        }),
        reorderLeadDays: null,
        schedules: daily,
      }),
    ).toBe(14);
  });

  it("reads the defaults (floor 7, lead 10) from an empty preferences row", () => {
    expect(
      resolvedLowStockTriggerDays({
        notificationPrefs: null,
        reorderLeadDays: null,
        schedules: daily,
      }),
    ).toBe(11);
  });

  it("is null when the alert is off", () => {
    expect(
      resolvedLowStockTriggerDays({
        notificationPrefs: prefs({ lowStockRunwayDays: null }),
        reorderLeadDays: null,
        schedules: daily,
      }),
    ).toBeNull();
  });

  it("is null when nothing is taken on a cadence", () => {
    expect(
      resolvedLowStockTriggerDays({
        notificationPrefs: prefs({ lowStockRunwayDays: 7 }),
        reorderLeadDays: null,
        schedules: [],
      }),
    ).toBeNull();
  });
});
