/**
 * Medication cadence and compliance against a naive oracle and against the
 * laws a rate has to obey.
 *
 * The oracle walks one local calendar day at a time and asks the only
 * question a person asks: is today one of my dose days, and how many doses
 * does it hold? The engine answers the same question through recurrence
 * rules, eras, bands and the zone's transitions; any disagreement on a random
 * schedule, day and zone is a defect in one of the two, and the oracle is
 * small enough to be obviously right.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildComplianceMedicationContext,
  calculateCompliance,
  expectedSlotCountForDay,
  type ComplianceSchedule,
  type IntakeEvent,
} from "@/lib/analytics/compliance";
import { shiftDateKey, weekdayOfDateKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";

import {
  assertProperty,
  zoneArb,
} from "../../../../../tests/property/fast-check";

const BYDAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

const dayKeyArb = fc
  .date({
    min: new Date("2025-01-01T00:00:00Z"),
    max: new Date("2027-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

const timeArb = fc
  .tuple(fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 15, 30, 45))
  .map(
    ([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  );

const timesArb = fc.uniqueArray(timeArb, { minLength: 1, maxLength: 3 });

const weekdaysArb = fc.uniqueArray(fc.integer({ min: 0, max: 6 }), {
  minLength: 1,
  maxLength: 7,
});

function context(tz: string) {
  return buildComplianceMedicationContext(
    {
      startsOn: null,
      endsOn: null,
      endedAt: null,
      oneShot: false,
      createdAt: new Date("2024-06-01T00:00:00Z"),
    },
    null,
    tz,
  );
}

function weeklySchedule(
  weekdays: number[],
  times: string[],
): ComplianceSchedule {
  return {
    windowStart: times[0],
    windowEnd: times[0],
    daysOfWeek: null,
    rrule: `FREQ=WEEKLY;BYDAY=${weekdays.map((d) => BYDAY[d]).join(",")}`,
    timesOfDay: [...times].sort(),
  };
}

describe("expected doses per local day", () => {
  it("a weekly schedule expects its doses exactly on its weekdays", () => {
    assertProperty(
      fc.property(
        weekdaysArb,
        timesArb,
        dayKeyArb,
        zoneArb,
        (weekdays, times, key, tz) => {
          const { dayStart, dayEnd } = localDayWindow(key, tz);
          const count = expectedSlotCountForDay(
            [weeklySchedule(weekdays, times)],
            dayStart,
            dayEnd,
            context(tz),
          );
          const oracle = weekdays.includes(weekdayOfDateKey(key))
            ? times.length
            : 0;
          expect(count).toBe(oracle);
        },
      ),
      300,
    );
  });

  it("a daily schedule expects every one of its times on every day", () => {
    assertProperty(
      fc.property(timesArb, dayKeyArb, zoneArb, (times, key, tz) => {
        const { dayStart, dayEnd } = localDayWindow(key, tz);
        const count = expectedSlotCountForDay(
          [
            {
              windowStart: times[0],
              windowEnd: times[0],
              daysOfWeek: null,
              rrule: "FREQ=DAILY",
              timesOfDay: [...times].sort(),
            },
          ],
          dayStart,
          dayEnd,
          context(tz),
        );
        expect(count).toBe(times.length);
      }),
      300,
    );
  });

  it("an as-needed schedule never expects a dose", () => {
    assertProperty(
      fc.property(timesArb, dayKeyArb, zoneArb, (times, key, tz) => {
        const { dayStart, dayEnd } = localDayWindow(key, tz);
        const count = expectedSlotCountForDay(
          [
            {
              windowStart: times[0],
              windowEnd: times[0],
              daysOfWeek: null,
              scheduleType: "PRN",
              rrule: "FREQ=DAILY",
              timesOfDay: [...times].sort(),
            },
          ],
          dayStart,
          dayEnd,
          context(tz),
        );
        expect(count).toBe(0);
      }),
    );
  });

  it("a week of a weekly schedule holds weekdays × times doses", () => {
    assertProperty(
      fc.property(
        weekdaysArb,
        timesArb,
        dayKeyArb,
        zoneArb,
        (weekdays, times, firstKey, tz) => {
          let total = 0;
          for (let i = 0; i < 7; i++) {
            const { dayStart, dayEnd } = localDayWindow(
              shiftDateKey(firstKey, i),
              tz,
            );
            total += expectedSlotCountForDay(
              [weeklySchedule(weekdays, times)],
              dayStart,
              dayEnd,
              context(tz),
            );
          }
          expect(total).toBe(weekdays.length * times.length);
        },
      ),
      80,
    );
  });
});

/** A daily 08:00 schedule and a 14-day history with random outcomes. */
const historyArb = fc.array(fc.constantFrom("taken", "skipped", "nothing"), {
  minLength: 14,
  maxLength: 14,
});

const NOW = new Date("2026-03-15T12:00:00Z");
const DAILY: ComplianceSchedule[] = [
  {
    windowStart: "08:00",
    windowEnd: "09:00",
    daysOfWeek: null,
    rrule: "FREQ=DAILY",
    timesOfDay: ["08:00"],
  },
];

function eventsFrom(outcomes: readonly string[]): IntakeEvent[] {
  return outcomes.flatMap((outcome, i): IntakeEvent[] => {
    const scheduledFor = new Date(
      Date.UTC(2026, 2, 15 - (outcomes.length - 1) + i, 8, 0),
    );
    if (outcome === "nothing") return [];
    return [
      {
        scheduledFor,
        takenAt:
          outcome === "taken"
            ? new Date(scheduledFor.getTime() + 10 * 60_000)
            : null,
        skipped: outcome === "skipped",
      },
    ];
  });
}

function rateOf(outcomes: readonly string[]) {
  return calculateCompliance(eventsFrom(outcomes), DAILY, 14, undefined, {
    now: NOW,
    medicationContext: context("UTC"),
  });
}

describe("the compliance rate", () => {
  it("stays within 0 to 100 and never counts more doses than expected", () => {
    assertProperty(
      fc.property(historyArb, (outcomes) => {
        const result = rateOf(outcomes);
        expect(result.rate).toBeGreaterThanOrEqual(0);
        expect(result.rate).toBeLessThanOrEqual(100);
        expect(result.taken).toBeLessThanOrEqual(result.totalExpected);
        expect(result.taken).toBe(outcomes.filter((o) => o === "taken").length);
      }),
    );
  });

  it("never falls when a missed dose is taken", () => {
    assertProperty(
      fc.property(
        historyArb,
        fc.integer({ min: 0, max: 13 }),
        (outcomes, index) => {
          fc.pre(outcomes[index] === "nothing");
          const after = [...outcomes];
          after[index] = "taken";
          expect(rateOf(after).rate).toBeGreaterThanOrEqual(
            rateOf(outcomes).rate,
          );
        },
      ),
    );
  });

  it("reads 100 when every expected dose was taken and 0 when none was", () => {
    expect(rateOf(Array(14).fill("taken")).rate).toBe(100);
    expect(rateOf(Array(14).fill("nothing")).rate).toBe(0);
  });
});
