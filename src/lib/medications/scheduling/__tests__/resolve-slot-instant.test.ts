/**
 * v1.8.2 — canonical slot-snap helper tests.
 *
 * Proves the snap contract the intake write paths depend on:
 *   - multi-time (07:00 / 19:00): an incoming instant near a slot snaps
 *     to that slot's canonical `localHmAsUtc` instant; a ±1-minute drift
 *     still snaps to the same instant (the duplicate-row root cause).
 *   - single-time: snaps to the one slot.
 *   - PRN schedule → null (keep insert behaviour, never collapse).
 *   - off-slot beyond tolerance → null.
 *   - DST spring-forward day still snaps to the canonical instant.
 */
import { describe, expect, it } from "vitest";

import { resolveCanonicalSlotInstant } from "../resolve-slot-instant";
import type { SlotResolverMedication } from "../resolve-slot-instant";
import type { WorkerScheduleRow } from "../worker-helpers";
import { localHmAsUtc } from "@/lib/timezone";

const TZ = "Europe/Berlin";

function makeSchedule(
  overrides: Partial<WorkerScheduleRow> = {},
): WorkerScheduleRow {
  return {
    id: "sched-1",
    windowStart: "07:00",
    windowEnd: "08:00",
    daysOfWeek: null,
    timesOfDay: [],
    reminderGraceMinutes: null,
    rrule: null,
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    ...overrides,
  };
}

function makeMedication(
  schedules: WorkerScheduleRow[],
  overrides: Partial<SlotResolverMedication> = {},
): SlotResolverMedication {
  return {
    id: "med-1",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    schedules,
    ...overrides,
  };
}

describe("resolveCanonicalSlotInstant — multi-time", () => {
  // A daily 07:00 / 19:00 med. 2026-06-15 is CEST (UTC+2), so 07:00 local
  // = 05:00Z and 19:00 local = 17:00Z.
  const med = makeMedication([
    makeSchedule({ timesOfDay: ["07:00", "19:00"], windowEnd: "07:00" }),
  ]);

  it("snaps an exact-07:00 write to the canonical 07:00 slot instant", () => {
    const incoming = new Date("2026-06-15T05:00:00.000Z"); // 07:00 CEST
    const result = resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming });
    const canonical = localHmAsUtc(incoming, TZ, 7, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });

  it("snaps a +1-minute-drifted 07:00 write to the SAME canonical instant", () => {
    const incoming = new Date("2026-06-15T05:01:00.000Z"); // 07:01 CEST
    const result = resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming });
    const canonical = localHmAsUtc(
      new Date("2026-06-15T05:00:00.000Z"),
      TZ,
      7,
      0,
    );
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });

  it("snaps a 19:00 write to the canonical 19:00 slot, not the 07:00 slot", () => {
    const incoming = new Date("2026-06-15T17:02:00.000Z"); // 19:02 CEST
    const result = resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming });
    const canonical = localHmAsUtc(incoming, TZ, 19, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — single-time", () => {
  it("snaps to the one slot", () => {
    const med = makeMedication([
      makeSchedule({ timesOfDay: ["08:00"], windowStart: "08:00", windowEnd: "09:00" }),
    ]);
    const incoming = new Date("2026-06-15T06:10:00.000Z"); // 08:10 CEST
    const result = resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming });
    const canonical = localHmAsUtc(incoming, TZ, 8, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — exemptions", () => {
  it("returns null for a PRN schedule (as-needed never snaps)", () => {
    const med = makeMedication([
      makeSchedule({ scheduleType: "PRN", timesOfDay: [] }),
    ]);
    const incoming = new Date("2026-06-15T05:00:00.000Z");
    expect(
      resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming }),
    ).toBeNull();
  });

  it("returns null for a medication with no schedules", () => {
    const med = makeMedication([]);
    const incoming = new Date("2026-06-15T05:00:00.000Z");
    expect(
      resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming }),
    ).toBeNull();
  });

  it("returns null for an off-slot write beyond tolerance", () => {
    // 07:00 / 19:00 schedule; a 13:00-local write is 4–6h from either
    // slot — well outside the ±2h default tolerance → unscheduled.
    const med = makeMedication([
      makeSchedule({ timesOfDay: ["07:00", "19:00"], windowEnd: "07:00" }),
    ]);
    const incoming = new Date("2026-06-15T11:00:00.000Z"); // 13:00 CEST
    expect(
      resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming }),
    ).toBeNull();
  });
});

describe("resolveCanonicalSlotInstant — DST spring-forward", () => {
  it("snaps a write on the 2026-03-29 spring-forward day to the canonical instant", () => {
    // 2026-03-29 is the CET→CEST transition. 08:00 local exists (the
    // gap is 02:00→03:00). The canonical instant must match localHmAsUtc.
    const med = makeMedication([
      makeSchedule({ timesOfDay: ["08:00"], windowStart: "08:00", windowEnd: "09:00" }),
    ]);
    const incoming = new Date("2026-03-29T06:05:00.000Z"); // 08:05 CEST
    const result = resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming });
    const canonical = localHmAsUtc(incoming, TZ, 8, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — DST robustness vs projector mint", () => {
  // v1.8.2 reconcile — the snapped instant MUST be byte-identical to the
  // projector/reminder-worker mint, which both use
  // `localHmAsUtc(<the day>, tz, h, m)`. The resolver re-mints via
  // `localHmAsUtc` from the occurrence's local day + time-of-day rather
  // than passing the recurrence engine's `wallClockInTz`-derived `at`
  // through, so the two agree even inside a DST transition window.

  it("matches the projector mint on the 2026-10-25 fall-back day", () => {
    // 2026-10-25 is the CEST→CET transition (the 02:00→03:00 hour repeats).
    // An 08:00 slot is unambiguous, but the date-arithmetic offset shifts
    // across the day; the resolver must still equal the projector's
    // localHmAsUtc(day, tz, 8, 0) mint.
    const med = makeMedication([
      makeSchedule({ timesOfDay: ["08:00"], windowStart: "08:00", windowEnd: "09:00" }),
    ]);
    const incoming = new Date("2026-10-25T07:10:00.000Z"); // 08:10 CET
    const result = resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming });
    // The projector mints with `localHmAsUtc(now, tz, h, m)` where `now`
    // lands on the same local day — assert byte-identity to that mint.
    const projectorMint = localHmAsUtc(incoming, TZ, 8, 0);
    expect(result?.toISOString()).toBe(projectorMint.toISOString());
  });

  it("snaps an early-morning slot near local midnight on a fall-back day to the projector mint", () => {
    // 06:00 slot on the fall-back day — close enough to the local-midnight
    // boundary that a naive same-UTC-day window could miss it, exercising
    // the resolver's padded-window + same-local-day filter.
    const med = makeMedication([
      makeSchedule({ timesOfDay: ["06:00"], windowStart: "06:00", windowEnd: "07:00" }),
    ]);
    const incoming = new Date("2026-10-25T05:02:00.000Z"); // 06:02 CET
    const result = resolveCanonicalSlotInstant({ medication: med, userTz: TZ, incoming });
    const projectorMint = localHmAsUtc(incoming, TZ, 6, 0);
    expect(result?.toISOString()).toBe(projectorMint.toISOString());
  });
});
