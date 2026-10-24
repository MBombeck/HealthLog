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
import { localHmAsUtc } from "@/lib/tz/local-day";

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
    endedAt: null,
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
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const canonical = localHmAsUtc(incoming, TZ, 7, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });

  it("snaps a +1-minute-drifted 07:00 write to the SAME canonical instant", () => {
    const incoming = new Date("2026-06-15T05:01:00.000Z"); // 07:01 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
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
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const canonical = localHmAsUtc(incoming, TZ, 19, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — taken write never snaps to a future slot (dose-safety)", () => {
  // Daily 07:00 / 19:00 med. A late morning dose taken at 15:00 CEST must
  // not snap forward onto the 19:00 slot (which is still in the future) and
  // render as "taken" before its time — the iOS v0.13 dose-safety report.
  const med = makeMedication([
    makeSchedule({ timesOfDay: ["07:00", "19:00"], windowEnd: "07:00" }),
  ]);
  // iOS posts the reminder-action write carrying the slot's `scheduledFor`
  // (19:00) while the dose is actually actioned earlier (17:00) — the
  // explicit instant names the future evening slot exactly.
  const slot1900Instant = new Date("2026-06-15T17:00:00.000Z"); // 19:00 CEST
  const beforeEvening = new Date("2026-06-15T15:00:00.000Z"); // 17:00 CEST

  it("LEGACY (no flag): an explicit 19:00 write snaps to the 19:00 slot", () => {
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: slot1900Instant,
    });
    const slot1900 = localHmAsUtc(slot1900Instant, TZ, 19, 0);
    expect(result?.toISOString()).toBe(slot1900.toISOString());
  });

  it("taken write naming the 19:00 slot, but actioned at 17:00, does NOT snap onto the future slot", () => {
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: slot1900Instant,
      isTakenWrite: true,
      now: beforeEvening,
    });
    // 19:00 is still in the future relative to now (17:00) → excluded;
    // 07:00 is 12h from the incoming instant → beyond tolerance → null.
    expect(result).toBeNull();
  });

  it("taken write AT the 19:00 slot still snaps (slot is not in the future)", () => {
    const evening = new Date("2026-06-15T17:02:00.000Z"); // 19:02 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: evening,
      isTakenWrite: true,
      now: evening,
    });
    const slot1900 = localHmAsUtc(evening, TZ, 19, 0);
    expect(result?.toISOString()).toBe(slot1900.toISOString());
  });

  it("taken write a few minutes early still snaps onto its slot (skew grace)", () => {
    // 06:57 CEST, slot 07:00 — within the 5-minute forward grace.
    const earlyTake = new Date("2026-06-15T04:57:00.000Z");
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: earlyTake,
      isTakenWrite: true,
      now: earlyTake,
    });
    const slot0700 = localHmAsUtc(earlyTake, TZ, 7, 0);
    expect(result?.toISOString()).toBe(slot0700.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — defaulted-now midday (phantom morning dose)", () => {
  // The phantom morning-dose bug: a 07:00 / 19:00 med whose 07:00 slot got
  // auto-marked taken because a slot-less midday "taken now" write
  // (no client `scheduledFor`) snapped across the ±6h half-gap window onto
  // the 07:00 slot. A DEFAULTED-now write (`instantIsExplicit: false`)
  // must NOT reach a far slot — only the tight dose-grace window snaps,
  // and 11:00 / 12:00 / 13:00 are well outside it, so the result is `null`
  // (PRN standalone row).
  const med = makeMedication([
    makeSchedule({ timesOfDay: ["07:00", "19:00"], windowEnd: "07:00" }),
  ]);

  for (const [label, hourUtc] of [
    ["11:00", 9],
    ["12:00", 10],
    ["13:00", 11],
  ] as const) {
    it(`returns null for a defaulted-now ${label}-local write`, () => {
      // CEST = UTC+2, so 11:00 local = 09:00Z, etc.
      const incoming = new Date(
        `2026-06-15T${String(hourUtc).padStart(2, "0")}:00:00.000Z`,
      );
      const result = resolveCanonicalSlotInstant({
        medication: med,
        userTz: TZ,
        incoming,
        instantIsExplicit: false,
      });
      expect(result).toBeNull();
    });
  }

  it("still snaps an EXPLICIT scheduledFor:07:00 write to the 07:00 slot", () => {
    const incoming = new Date("2026-06-15T05:00:00.000Z"); // 07:00 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
      instantIsExplicit: true,
    });
    const canonical = localHmAsUtc(incoming, TZ, 7, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });

  it("defaults to explicit snap when the flag is omitted (legacy behaviour)", () => {
    const incoming = new Date("2026-06-15T05:00:00.000Z"); // 07:00 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const canonical = localHmAsUtc(incoming, TZ, 7, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — multi-time wide window", () => {
  // The LIVE twice-daily-Ramipril regression: 08:00 / 20:00 doses with a
  // WIDE schedule window (08:00–22:00 = 14h span → ±7h half-span). The
  // pre-fix tolerance exceeded half the 12h inter-slot gap (±6h), so the
  // 20:00 write's capture zone overlapped the 08:00 slot and a distinct
  // evening dose collapsed onto the already-taken morning slot — leaving
  // "nothing in Verlauf". The cap at half the inter-dose gap fixes it.
  const med = makeMedication([
    makeSchedule({
      timesOfDay: ["08:00", "20:00"],
      windowStart: "08:00",
      windowEnd: "22:00",
    }),
  ]);

  it("snaps a 20:00 write to the 20:00 slot, NOT the wide-window 08:00 slot", () => {
    const incoming = new Date("2026-06-15T18:00:00.000Z"); // 20:00 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const evening = localHmAsUtc(incoming, TZ, 20, 0);
    const morning = localHmAsUtc(incoming, TZ, 8, 0);
    expect(result?.toISOString()).toBe(evening.toISOString());
    expect(result?.toISOString()).not.toBe(morning.toISOString());
  });

  it("snaps an 08:00 write to the 08:00 slot", () => {
    const incoming = new Date("2026-06-15T06:00:00.000Z"); // 08:00 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const morning = localHmAsUtc(incoming, TZ, 8, 0);
    expect(result?.toISOString()).toBe(morning.toISOString());
  });

  it("resolves the morning and evening writes to TWO distinct slot instants", () => {
    const morningWrite = new Date("2026-06-15T06:05:00.000Z"); // 08:05 CEST
    const eveningWrite = new Date("2026-06-15T18:03:00.000Z"); // 20:03 CEST
    const morningSlot = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: morningWrite,
    });
    const eveningSlot = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: eveningWrite,
    });
    expect(morningSlot).not.toBeNull();
    expect(eveningSlot).not.toBeNull();
    // The two distinct doses must NOT collapse onto the same canonical slot.
    expect(morningSlot?.toISOString()).not.toBe(eveningSlot?.toISOString());
    expect(morningSlot?.toISOString()).toBe(
      localHmAsUtc(morningWrite, TZ, 8, 0).toISOString(),
    );
    expect(eveningSlot?.toISOString()).toBe(
      localHmAsUtc(eveningWrite, TZ, 20, 0).toISOString(),
    );
  });

  it("snaps a write 90 minutes past the morning slot to the morning slot", () => {
    // 09:30 local is 1.5h after 08:00, well inside the ±6h capture zone and
    // far from 20:00 — must resolve to the morning slot, not the evening.
    const incoming = new Date("2026-06-15T07:30:00.000Z"); // 09:30 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    expect(result?.toISOString()).toBe(
      localHmAsUtc(incoming, TZ, 8, 0).toISOString(),
    );
  });
});

describe("resolveCanonicalSlotInstant — single-time", () => {
  it("snaps to the one slot", () => {
    const med = makeMedication([
      makeSchedule({
        timesOfDay: ["08:00"],
        windowStart: "08:00",
        windowEnd: "09:00",
      }),
    ]);
    const incoming = new Date("2026-06-15T06:10:00.000Z"); // 08:10 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const canonical = localHmAsUtc(incoming, TZ, 8, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — weekly single-dose unchanged", () => {
  // A once-weekly injectable (one slot/day) is immune to the overlap bug
  // and must keep its full half-window-span tolerance: the inter-dose cap
  // only kicks in for >1 slot/day. Use a wide window to prove the cap is
  // NOT applied for a single slot — a 10:30 write 2.5h from the 08:00 slot
  // still snaps (±7h half-span, no per-slot cap).
  const med = makeMedication([
    makeSchedule({
      timesOfDay: ["08:00"],
      windowStart: "08:00",
      windowEnd: "22:00",
      daysOfWeek: "MO",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    }),
  ]);

  it("snaps a same-day write well outside an inter-dose gap (full half-span retained)", () => {
    // 2026-06-15 is a Monday. 10:30 CEST is 2.5h past 08:00 — outside any
    // ±6h inter-dose cap a multi-slot schedule would impose, inside the
    // ±7h single-slot half-span.
    const incoming = new Date("2026-06-15T08:30:00.000Z"); // 10:30 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    expect(result?.toISOString()).toBe(
      localHmAsUtc(incoming, TZ, 8, 0).toISOString(),
    );
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
      makeSchedule({
        timesOfDay: ["08:00"],
        windowStart: "08:00",
        windowEnd: "09:00",
      }),
    ]);
    const incoming = new Date("2026-03-29T06:05:00.000Z"); // 08:05 CEST
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const canonical = localHmAsUtc(incoming, TZ, 8, 0);
    expect(result?.toISOString()).toBe(canonical.toISOString());
  });
});

describe("resolveCanonicalSlotInstant — DST robustness vs projector mint", () => {
  // v1.8.2 — the snapped instant MUST be byte-identical to the
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
      makeSchedule({
        timesOfDay: ["08:00"],
        windowStart: "08:00",
        windowEnd: "09:00",
      }),
    ]);
    const incoming = new Date("2026-10-25T07:10:00.000Z"); // 08:10 CET
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
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
      makeSchedule({
        timesOfDay: ["06:00"],
        windowStart: "06:00",
        windowEnd: "07:00",
      }),
    ]);
    const incoming = new Date("2026-10-25T05:02:00.000Z"); // 06:02 CET
    const result = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming,
    });
    const projectorMint = localHmAsUtc(incoming, TZ, 6, 0);
    expect(result?.toISOString()).toBe(projectorMint.toISOString());
  });
});

describe("slot dedupe contract — projector, reminder worker and intake write", () => {
  // The three surfaces key on the slot instant BYTE-FOR-BYTE: the projector
  // mints a pending row at `localHmAsUtc(<its tick>, tz, h, m)`, the reminder
  // worker re-derives the same slot from ITS tick, and the intake write path
  // snaps an incoming take to the canonical instant via
  // `resolveCanonicalSlotInstant`. All three reference instants are
  // different by construction — a cron tick, a later cron tick, and the
  // moment the user actually pressed "take".
  //
  // That is the whole hazard. The primitive used to sample the zone offset
  // at its REFERENCE rather than at the target local time, so on a
  // transition day a pre-transition tick and a post-transition tick minted
  // instants an hour apart for the same slot — the dedupe key stopped
  // matching and a duplicate pending row became reachable.
  //
  // The existing DST cases above compare the resolver to a projector mint
  // computed from the SAME reference, which cannot see this. These pass
  // deliberately different references.

  const SLOT_HOUR = 20;
  const med = makeMedication([
    makeSchedule({
      timesOfDay: ["20:00"],
      windowStart: "20:00",
      windowEnd: "21:00",
    }),
  ]);

  it("agrees across references on either side of the autumn fall-back", () => {
    // Europe/Berlin 2026-10-25: 03:00 CEST → 02:00 CET.
    const projectorTick = new Date("2026-10-25T00:30:00.000Z"); // 02:30 CEST
    const workerTick = new Date("2026-10-25T17:00:00.000Z"); // 18:00 CET
    const takePressedAt = new Date("2026-10-25T19:10:00.000Z"); // 20:10 CET

    const projectorMint = localHmAsUtc(projectorTick, TZ, SLOT_HOUR, 0);
    const workerMint = localHmAsUtc(workerTick, TZ, SLOT_HOUR, 0);
    const writeMint = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: takePressedAt,
    });

    expect(workerMint.toISOString()).toBe(projectorMint.toISOString());
    expect(writeMint?.toISOString()).toBe(projectorMint.toISOString());
    // And the shared instant really is 20:00 on the user's clock.
    expect(projectorMint.toISOString()).toBe("2026-10-25T19:00:00.000Z");
  });

  it("agrees across references on either side of the spring-forward", () => {
    // Europe/Berlin 2026-03-29: 02:00 CET → 03:00 CEST.
    const projectorTick = new Date("2026-03-29T00:30:00.000Z"); // 01:30 CET
    const workerTick = new Date("2026-03-29T16:00:00.000Z"); // 18:00 CEST
    const takePressedAt = new Date("2026-03-29T18:10:00.000Z"); // 20:10 CEST

    const projectorMint = localHmAsUtc(projectorTick, TZ, SLOT_HOUR, 0);
    const workerMint = localHmAsUtc(workerTick, TZ, SLOT_HOUR, 0);
    const writeMint = resolveCanonicalSlotInstant({
      medication: med,
      userTz: TZ,
      incoming: takePressedAt,
    });

    expect(workerMint.toISOString()).toBe(projectorMint.toISOString());
    expect(writeMint?.toISOString()).toBe(projectorMint.toISOString());
    expect(projectorMint.toISOString()).toBe("2026-03-29T18:00:00.000Z");
  });
});
