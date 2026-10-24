/**
 * v1.15.18 — WRITE/EDIT-path band attribution.
 *
 * `attributeTakenToSlot` is the write-side counterpart to the read-side
 * ledger: both run the SAME shared band minter so a take is bound to a slot
 * identically wherever it is decided. These tests pin the behaviour the audit
 * called out (HIGH-5: the ±6h snap fully gone) + the late-take force-attribute
 * guard (the maintainer's "diesem Slot zuordnen?" nudge):
 *
 *   - on-time take      → its own slot anchor;
 *   - clearly off-window → ad-hoc (null), NOT the nearest snapped slot;
 *   - late-but-in-tail   → the slot, status late;
 *   - PRN / no schedule  → always ad-hoc (hasExpectedSlots false);
 *   - force-attribute    → resolves only a REAL slot anchor, never an
 *                          arbitrary instant.
 */
import { describe, expect, it } from "vitest";

import {
  attributeTakenToSlot,
  resolveForcedSlotInstant,
  type AttributeIntakeMedication,
} from "../attribute-intake";
import type { WorkerScheduleRow } from "../worker-helpers";
import { localHmAsUtc } from "@/lib/tz/local-day";

const TZ = "Europe/Berlin";

function schedule(over: Partial<WorkerScheduleRow> = {}): WorkerScheduleRow {
  return {
    id: "sched-1",
    windowStart: "08:00",
    windowEnd: "08:00",
    daysOfWeek: null,
    timesOfDay: [],
    reminderGraceMinutes: null,
    rrule: null,
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...over,
  };
}

function med(
  schedules: WorkerScheduleRow[],
  over: Partial<AttributeIntakeMedication> = {},
): AttributeIntakeMedication {
  return {
    id: "med-1",
    startsOn: null,
    endsOn: null,
    endedAt: null,
    oneShot: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    schedules,
    ...over,
  };
}

/** Berlin wall-clock HH:mm on the day implied by `dayRef`. */
function at(dayRef: Date, h: number, m: number): Date {
  return localHmAsUtc(dayRef, TZ, h, m);
}

const DAY = new Date("2026-06-08T12:00:00Z"); // CEST

describe("attributeTakenToSlot — twice-daily 07:00 / 19:00 (the maintainer's case)", () => {
  const m = med([schedule({ timesOfDay: ["07:00", "19:00"] })]);

  it("snaps an on-time morning take to the 07:00 slot", () => {
    const takenAt = at(DAY, 7, 5);
    const out = attributeTakenToSlot({ medication: m, userTz: TZ, takenAt });
    expect(out.slotInstant?.getTime()).toBe(at(DAY, 7, 0).getTime());
    expect(out.status).toBe("on_time");
  });

  it("treats the 11:29 take as ad-hoc, NOT a snapped 07:00 dose (HIGH-5)", () => {
    // The retired ±6h snap pulled 11:29 onto 07:00. Band membership orphans it.
    const takenAt = at(DAY, 11, 29);
    const out = attributeTakenToSlot({ medication: m, userTz: TZ, takenAt });
    expect(out.slotInstant).toBeNull();
    expect(out.status).toBeNull();
    expect(out.hasExpectedSlots).toBe(true);
  });

  it("treats a 13:02 take as ad-hoc, never the 19:00 slot (HIGH-5)", () => {
    const takenAt = at(DAY, 13, 2);
    const out = attributeTakenToSlot({ medication: m, userTz: TZ, takenAt });
    expect(out.slotInstant).toBeNull();
  });

  it("snaps a slightly-late evening take to the 19:00 slot as late", () => {
    // 19:00 + 90min is inside the daily late tail (180min default).
    const takenAt = at(DAY, 20, 30);
    const out = attributeTakenToSlot({ medication: m, userTz: TZ, takenAt });
    expect(out.slotInstant?.getTime()).toBe(at(DAY, 19, 0).getTime());
    expect(out.status).toBe("late");
  });
});

describe("attributeTakenToSlot — PRN / unscheduled", () => {
  it("returns ad-hoc with hasExpectedSlots false for a PRN schedule", () => {
    const m = med([schedule({ scheduleType: "PRN", timesOfDay: [] })]);
    const out = attributeTakenToSlot({
      medication: m,
      userTz: TZ,
      takenAt: at(DAY, 14, 0),
    });
    expect(out.slotInstant).toBeNull();
    expect(out.hasExpectedSlots).toBe(false);
  });

  it("returns ad-hoc for a medication with no schedules", () => {
    const m = med([]);
    const out = attributeTakenToSlot({
      medication: m,
      userTz: TZ,
      takenAt: at(DAY, 7, 0),
    });
    expect(out.slotInstant).toBeNull();
    expect(out.hasExpectedSlots).toBe(false);
  });
});

describe("attributeTakenToSlot — weekly day-scale late tail", () => {
  // Weekly Monday 08:00 (legacy daysOfWeek shape). DAY (2026-06-08) is a
  // Monday, so the anchor is Monday 08:00 and the band spans Sun 08:00 →
  // Tue 08:00 on-time plus the 4-day overdue tail to Sat 08:00.
  const weekly = med([schedule({ daysOfWeek: "1", timesOfDay: ["08:00"] })]);

  it("binds a take 3 days after the anchor to the slot as late, not ad-hoc", () => {
    // Thursday 08:00 — inside the 4-day overdue tail, but 3 days past the
    // anchor: a ±1-day mint range never surfaces the Monday band.
    const takenAt = at(new Date("2026-06-11T12:00:00Z"), 8, 0);
    const out = attributeTakenToSlot({
      medication: weekly,
      userTz: TZ,
      takenAt,
    });
    expect(out.slotInstant?.getTime()).toBe(at(DAY, 8, 0).getTime());
    expect(out.status).toBe("late");
  });

  it("treats a take past the overdue tail as ad-hoc (bi-weekly, +6 days)", () => {
    // Bi-weekly Monday anchored at startsOn = Mon 2026-06-08; the next
    // anchor (Jun 22) is two weeks out, so day +6 sits in the dead zone
    // past the tail (Sat Jun 13 08:00) and before the next on-time band.
    const biWeekly = med(
      [schedule({ daysOfWeek: "i2;1", timesOfDay: ["08:00"] })],
      { startsOn: new Date("2026-06-08T00:00:00Z") },
    );
    const takenAt = at(new Date("2026-06-14T12:00:00Z"), 8, 0);
    const out = attributeTakenToSlot({
      medication: biWeekly,
      userTz: TZ,
      takenAt,
    });
    expect(out.slotInstant).toBeNull();
    expect(out.status).toBeNull();
    expect(out.hasExpectedSlots).toBe(true);
  });

  it("binds a rolling take 4 days after the projected next-due as late", () => {
    // 7-day rolling, last shot Mon Jun 1 08:00 → next due Mon Jun 8 08:00.
    // Take Friday Jun 12 08:00: 4 days past the anchor (inside the tail,
    // and past the half-cycle gate that emits the overdue forward slot).
    const rolling = med([
      schedule({ rollingIntervalDays: 7, timesOfDay: ["08:00"] }),
    ]);
    const lastShot = at(new Date("2026-06-01T12:00:00Z"), 8, 0);
    const takenAt = at(new Date("2026-06-12T12:00:00Z"), 8, 0);
    const out = attributeTakenToSlot({
      medication: rolling,
      userTz: TZ,
      takenAt,
      lastIntakeAt: lastShot,
      intakeInstants: [lastShot],
    });
    expect(out.slotInstant?.getTime()).toBe(at(DAY, 8, 0).getTime());
    expect(out.status).toBe("late");
  });

  it("binds a 3-days-late weekly take across the spring DST transition", () => {
    // Friday 2026-03-27 08:00 CET anchor; the take lands Monday 2026-03-30
    // 08:00 CEST — 3 days later across the Mar 29 spring-forward shift.
    const friday = med([schedule({ daysOfWeek: "5", timesOfDay: ["08:00"] })]);
    const anchorDay = new Date("2026-03-27T12:00:00Z");
    const takenAt = at(new Date("2026-03-30T12:00:00Z"), 8, 0);
    const out = attributeTakenToSlot({
      medication: friday,
      userTz: TZ,
      takenAt,
    });
    expect(out.slotInstant?.getTime()).toBe(at(anchorDay, 8, 0).getTime());
    expect(out.status).toBe("late");
  });
});

describe("attributeTakenToSlot — DST correctness", () => {
  it("snaps a winter (CET) on-time take to its slot", () => {
    const winterDay = new Date("2026-01-15T12:00:00Z"); // CET
    const m = med([schedule({ timesOfDay: ["07:00", "19:00"] })]);
    const takenAt = at(winterDay, 19, 10);
    const out = attributeTakenToSlot({ medication: m, userTz: TZ, takenAt });
    expect(out.slotInstant?.getTime()).toBe(at(winterDay, 19, 0).getTime());
    expect(out.status).toBe("on_time");
  });
});

describe("resolveForcedSlotInstant — the late-take nudge guard", () => {
  const m = med([schedule({ timesOfDay: ["07:00", "19:00"] })]);

  it("resolves a real slot anchor the client pins onto", () => {
    const slot = at(DAY, 7, 0);
    const out = resolveForcedSlotInstant({
      medication: m,
      userTz: TZ,
      slotInstant: slot,
    });
    expect(out?.getTime()).toBe(slot.getTime());
  });

  it("tolerates sub-minute client drift on the pinned anchor", () => {
    const slot = new Date(at(DAY, 19, 0).getTime() + 30_000);
    const out = resolveForcedSlotInstant({
      medication: m,
      userTz: TZ,
      slotInstant: slot,
    });
    expect(out?.getTime()).toBe(at(DAY, 19, 0).getTime());
  });

  it("refuses an arbitrary off-slot instant (cannot pin a non-slot)", () => {
    const out = resolveForcedSlotInstant({
      medication: m,
      userTz: TZ,
      slotInstant: at(DAY, 11, 29),
    });
    expect(out).toBeNull();
  });

  it("refuses any pin for a PRN medication (no slots)", () => {
    const prn = med([schedule({ scheduleType: "PRN", timesOfDay: [] })]);
    const out = resolveForcedSlotInstant({
      medication: prn,
      userTz: TZ,
      slotInstant: at(DAY, 7, 0),
    });
    expect(out).toBeNull();
  });
});
