/**
 * The two compliance engines must report the SAME rate for the same day.
 *
 * `tallyComplianceFromLedger` (the dose-history ledger behind the medication
 * card, the history view, the doctor report and the Health Score pillar) has
 * excluded a deliberately skipped dose from the denominator since v1.15.9 —
 * a skip is a pause, not a miss. `buildScheduleAnchoredComplianceBuckets`
 * (the dashboard tile and the adherence storyline) counted the same slot as
 * expected-and-missed, because its denominator was the raw expected-slot
 * count with no skip term. One day, two figures: 67 % on the card, 50 % on
 * the tile.
 *
 * This test feeds ONE fixture to BOTH engines and pins them to one number, so
 * the divergence cannot come back through either side.
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  medicationFindMany: vi.fn(),
  intakeFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: mocks.medicationFindMany },
    medicationIntakeEvent: { findMany: mocks.intakeFindMany },
  },
}));

import {
  buildComplianceMedicationContext,
  tallyComplianceFromLedger,
  type ComplianceSchedule,
  type IntakeEvent,
} from "@/lib/analytics/compliance";
import { buildScheduleAnchoredComplianceBuckets } from "@/lib/analytics/schedule-anchored-compliance";

const TZ = "UTC";
/** Late enough that every slot in the two-day window is past its cutoff. */
const NOW = new Date("2026-06-10T23:00:00.000Z");
const WINDOW_FROM = new Date("2026-06-09T00:00:00.000Z");

/** A twice-daily plan: 08:00 and 20:00, every day. */
const twiceDaily: ComplianceSchedule = {
  windowStart: "08:00",
  windowEnd: "09:00",
  daysOfWeek: null,
  rrule: "FREQ=DAILY",
  rollingIntervalDays: null,
  timesOfDay: ["08:00", "20:00"],
  reminderGraceMinutes: null,
  scheduleType: "SCHEDULED",
  cyclicOnWeeks: null,
  cyclicOffWeeks: null,
  doseWindows: null,
};

const medication = {
  id: "med-1",
  userId: "user-1",
  active: true,
  startsOn: null,
  endsOn: null,
  oneShot: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  schedules: [twiceDaily],
  scheduleRevisions: [],
  pauseEras: [],
};

/**
 * Four expected slots across two days:
 *   09.06. 08:00 — taken
 *   09.06. 20:00 — SKIPPED (deliberate)
 *   10.06. 08:00 — missed (no row at all)
 *   10.06. 20:00 — taken
 *
 * Both engines must read 2 taken of 3 expected → 67 %. The pre-fix tile
 * counted the skip as expected-and-missed: 2 of 4 → 50 %.
 */
const events: IntakeEvent[] = [
  {
    scheduledFor: new Date("2026-06-09T08:00:00.000Z"),
    takenAt: new Date("2026-06-09T08:05:00.000Z"),
    skipped: false,
    autoMissed: false,
  },
  {
    scheduledFor: new Date("2026-06-09T20:00:00.000Z"),
    takenAt: null,
    skipped: true,
    autoMissed: false,
  },
  {
    scheduledFor: new Date("2026-06-10T20:00:00.000Z"),
    takenAt: new Date("2026-06-10T20:05:00.000Z"),
    skipped: false,
    autoMissed: false,
  },
];

const EXPECTED_RATE = 67;

describe("compliance engines agree on a deliberately skipped dose", () => {
  it("the ledger tally leaves the skip out of the denominator (2 taken of 3 expected)", () => {
    const ctx = buildComplianceMedicationContext(medication, null, TZ);
    const tally = tallyComplianceFromLedger(
      events,
      [twiceDaily],
      ctx,
      WINDOW_FROM,
      NOW,
      NOW,
    );

    expect(tally.taken).toBe(2);
    expect(tally.skipped).toBe(1);
    expect(tally.missed).toBe(1);
    expect(tally.denominator).toBe(3);
    expect(tally.rate).toBe(EXPECTED_RATE);
  });

  it("the schedule-anchored buckets read the same rate on the same fixture", async () => {
    mocks.medicationFindMany.mockResolvedValue([medication]);
    mocks.intakeFindMany.mockResolvedValue(
      events.map((e) => ({ ...e, medicationId: medication.id })),
    );

    const buckets = await buildScheduleAnchoredComplianceBuckets(
      "user-1",
      2,
      TZ,
      NOW,
    );

    const scheduled = buckets.reduce((s, b) => s + b.scheduled, 0);
    const taken = buckets.reduce((s, b) => s + b.taken, 0);

    // The skipped slot is gone from the denominator, exactly as in the ledger.
    expect(scheduled).toBe(3);
    expect(taken).toBe(2);
    expect(Math.min(100, Math.round((taken / scheduled) * 100))).toBe(
      EXPECTED_RATE,
    );

    // The day carrying the skip reads 1 of 1, not 1 of 2.
    const skipDay = buckets.find((b) => b.date === "2026-06-09");
    expect(skipDay).toEqual({ date: "2026-06-09", scheduled: 1, taken: 1 });
  });

  it("a day whose every dose was skipped drops out of both denominators", async () => {
    const allSkipped: IntakeEvent[] = [
      {
        scheduledFor: new Date("2026-06-10T08:00:00.000Z"),
        takenAt: null,
        skipped: true,
        autoMissed: false,
      },
      {
        scheduledFor: new Date("2026-06-10T20:00:00.000Z"),
        takenAt: null,
        skipped: true,
        autoMissed: false,
      },
    ];

    const ctx = buildComplianceMedicationContext(medication, null, TZ);
    const tally = tallyComplianceFromLedger(
      allSkipped,
      [twiceDaily],
      ctx,
      new Date("2026-06-10T00:00:00.000Z"),
      NOW,
      NOW,
    );
    expect(tally.denominator).toBe(0);

    mocks.medicationFindMany.mockResolvedValue([medication]);
    mocks.intakeFindMany.mockResolvedValue(
      allSkipped.map((e) => ({ ...e, medicationId: medication.id })),
    );
    const buckets = await buildScheduleAnchoredComplianceBuckets(
      "user-1",
      1,
      TZ,
      NOW,
    );
    // `scheduled: 0` is what the chart filters out — no bar, not a 0 % bar.
    expect(buckets).toEqual([{ date: "2026-06-10", scheduled: 0, taken: 0 }]);
  });
});
