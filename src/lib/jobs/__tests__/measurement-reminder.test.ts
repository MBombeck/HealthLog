/**
 * v1.17.1 — Vorsorge (measurement) reminder dispatcher unit tests.
 *
 * Pins the contract:
 *   - Due-predicate window: fires only when past-due AND inside the
 *     reminder's local notify-hour (08:59 → no, 09:00 → yes, 09:59 →
 *     yes, 10:00 → no). A disabled reminder / null nextDueAt never fires.
 *   - Auto-resolve: a matching reading of the reminder's measurementType
 *     logged since the last satisfy advances lastSatisfiedAt + recomputes
 *     nextDueAt and suppresses the nudge. Free-text reminders never
 *     auto-resolve.
 *   - A reminder on a weekly or shorter cycle rolls on: a successful
 *     dispatch advances nextDueAt past now. One on a longer cycle, or a
 *     one-shot, does NOT roll on (measurement reminder or free text): it
 *     stays due until it is satisfied, and a second nudge for the same open
 *     slot waits a week. Appointments stay one-shot.
 *   - clientManaged suppresses the APNs leg only: the tick still
 *     dispatches, and a reminder nothing delivered stays overdue.
 *
 * The Prisma surface is stubbed manually to avoid a testcontainer boot.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";

// v1.37.19 (A6-7) — the tick claims the slot BEFORE provider egress via
// the shared record-event ledger. The manual Prisma double has no
// notification_events surface, so the claim is mocked controllable:
// default granted, individual cases flip it to prove the guard.
const claimState = vi.hoisted(() => ({ granted: true }));
const claimMock = vi.hoisted(() => vi.fn(async () => claimState.granted));
vi.mock("@/lib/notifications/reminder-dedup", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/notifications/reminder-dedup")
  >("@/lib/notifications/reminder-dedup");
  return { ...actual, claimNotificationEvent: claimMock };
});

import {
  evaluateMeasurementReminderDue,
  runMeasurementReminderTick,
} from "../measurement-reminder";
import type { NotificationPayload } from "@/lib/notifications/types";
import type { DispatchOutcome } from "@/lib/notifications/dispatcher";

type DispatchFn = (payload: NotificationPayload) => Promise<DispatchOutcome>;

const OK: DispatchOutcome = {
  dispatched: true,
  channelsAttempted: 1,
  channelsSucceeded: 1,
};

const TZ = "Europe/Berlin";

beforeEach(() => {
  claimState.granted = true;
  claimMock.mockClear();
});

// 09:00 Berlin in June = 07:00Z.
const NINE_LOCAL = new Date("2026-06-15T07:00:00Z");

describe("evaluateMeasurementReminderDue — window boundary", () => {
  const reminder = { enabled: true, notifyHour: 9, nextDueAt: new Date(0) };

  it("08:59 local → not in hour window", () => {
    const d = evaluateMeasurementReminderDue(
      reminder,
      TZ,
      new Date("2026-06-15T06:59:00Z"),
    );
    expect(d.isDue).toBe(true);
    expect(d.inHourWindow).toBe(false);
    expect(d.fire).toBe(false);
  });

  it("09:00 local → fires", () => {
    const d = evaluateMeasurementReminderDue(reminder, TZ, NINE_LOCAL);
    expect(d.fire).toBe(true);
  });

  it("09:59 local → still in window", () => {
    const d = evaluateMeasurementReminderDue(
      reminder,
      TZ,
      new Date("2026-06-15T07:59:00Z"),
    );
    expect(d.fire).toBe(true);
  });

  it("10:00 local → outside window", () => {
    const d = evaluateMeasurementReminderDue(
      reminder,
      TZ,
      new Date("2026-06-15T08:00:00Z"),
    );
    expect(d.inHourWindow).toBe(false);
    expect(d.fire).toBe(false);
  });

  it("not yet due → never fires", () => {
    const d = evaluateMeasurementReminderDue(
      { enabled: true, notifyHour: 9, nextDueAt: new Date("2099-01-01") },
      TZ,
      NINE_LOCAL,
    );
    expect(d.isDue).toBe(false);
    expect(d.fire).toBe(false);
  });

  it("disabled / null nextDueAt → never fires", () => {
    expect(
      evaluateMeasurementReminderDue(
        { enabled: false, notifyHour: 9, nextDueAt: new Date(0) },
        TZ,
        NINE_LOCAL,
      ).fire,
    ).toBe(false);
    expect(
      evaluateMeasurementReminderDue(
        { enabled: true, notifyHour: 9, nextDueAt: null },
        TZ,
        NINE_LOCAL,
      ).fire,
    ).toBe(false);
  });
});

interface FakeReminder {
  id: string;
  userId: string;
  /** Absent on a checkup fixture; `"ENCOUNTER"` on an appointment's row. */
  origin?: string;
  measurementType: string | null;
  lastSkippedAt: Date | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: Date | null;
  notifyHour: number;
  location: string | null;
  nextDueAt: Date | null;
  lastSatisfiedAt: Date | null;
  /** v1.39.2 — the last delivered nudge; absent on most fixtures. */
  lastNotifiedAt?: Date | null;
  enabled: boolean;
  createdAt: Date;
  user: {
    id: string;
    timezone: string;
    locale: string | null;
    notificationPrefs: unknown;
  };
}

function makePrisma(opts: {
  reminders: FakeReminder[];
  measurementMatch?: { measuredAt: Date } | null;
  /** v1.18.1 (D2) — a free-text reminder now auto-resolves from a matching
   *  LabResult. Default `null` (no lab landed). */
  labMatch?: { takenAt: Date } | null;
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    measurementReminder: {
      findMany: vi.fn(async () => opts.reminders),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          updates.push({ id: where.id, data });
          return { id: where.id, ...data };
        },
      ),
      // v1.18.1 — two callers use `updateMany` against this model now:
      //  - `satisfyReminder` (conditional forward-only write) — has `where.id`
      //    and should record the write so the satisfy assertions still see it.
      //  - the tick's expired-COACH cleanup sweep — no `where.id`; record
      //    nothing and report zero rows cleaned (the fixtures carry no
      //    expired COACH rows).
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string };
          data: Record<string, unknown>;
        }) => {
          if (where.id) {
            updates.push({ id: where.id, data });
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
    measurement: {
      findFirst: vi.fn(async () => opts.measurementMatch ?? null),
    },
    labResult: {
      findFirst: vi.fn(async () => opts.labMatch ?? null),
    },
    // v1.37.20 (#223 / iOS #68) — the satisfy primitive appends a ledger
    // row per applied satisfy.
    measurementReminderEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "evt",
        ...data,
      })),
    },
  };
  return { prisma, updates };
}

function reminder(overrides: Partial<FakeReminder>): FakeReminder {
  return {
    id: "r1",
    userId: "u1",
    measurementType: "BLOOD_PRESSURE_SYS",
    intervalDays: 7,
    rrule: null,
    anchorDate: null,
    notifyHour: 9,
    location: null,
    nextDueAt: new Date("2026-06-14T07:00:00Z"), // past at NINE_LOCAL
    lastSatisfiedAt: null,
    lastSkippedAt: null,
    enabled: true,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    user: {
      id: "u1",
      timezone: TZ,
      locale: "de",
      notificationPrefs: null,
    },
    ...overrides,
  };
}

describe("runMeasurementReminderTick", () => {
  it("auto-resolves a typed reminder when a matching reading landed", async () => {
    const matchAt = new Date("2026-06-14T18:00:00Z");
    const { prisma, updates } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: { measuredAt: matchAt },
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.autoResolved).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    // Advanced lastSatisfiedAt to the reading instant + recomputed nextDueAt.
    expect(updates).toHaveLength(1);
    expect(updates[0].data.lastSatisfiedAt).toEqual(matchAt);
    expect(updates[0].data.nextDueAt).toBeInstanceOf(Date);
  });

  // Watched red: with the claim-before-dispatch guard removed from the
  // tick (the pre-v1.37.19 order: dispatch first, advance after), the
  // denied-claim case below fails — the provider was contacted although
  // another worker (or a crash-recovery replay) already owned the slot.
  it("claims the slot BEFORE provider egress and skips when denied", async () => {
    claimState.granted = false;
    const { prisma, updates } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(summary.skippedAlreadyClaimed).toBe(1);
    expect(summary.dispatched).toBe(0);
    // No advance either — the claimant owns the slot's lifecycle.
    expect(updates).toHaveLength(0);
  });

  it("keys the claim on the reminder + the user-local date", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(claimMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        eventType: "MEASUREMENT_REMINDER",
        dedupKey: expect.stringMatching(/^measurement:.+:2026-06-15$/),
      }),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("dispatches a due reminder and advances nextDueAt past now (ledger-free dedup)", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.dispatched).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].eventType).toBe("MEASUREMENT_REMINDER");
    // nextDueAt advanced strictly past now.
    expect(updates).toHaveLength(1);
    const advanced = updates[0].data.nextDueAt as Date;
    expect(advanced.getTime()).toBeGreaterThan(NINE_LOCAL.getTime());
  });

  it("dispatches an appointment nudge with its completion affordance suppressed", async () => {
    // `measure_done` / `measure_later` and the iOS "Erledigt" action all
    // resolve the reminder by id, and every by-id surface refuses an
    // ENCOUNTER-origin row. The producer knows the origin, so it is the
    // producer that says the dispatch carries no action; the channels drop
    // their own affordance from the flag.
    const { prisma } = makePrisma({
      reminders: [
        reminder({ origin: "ENCOUNTER", measurementType: null, id: "appt-1" }),
      ],
      measurementMatch: null,
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const payload = dispatch.mock.calls[0][0];
    expect(payload.suppressActions).toBe(true);
    // The id still rides the dispatch — it identifies the nudge for the
    // client-managed suppression tag. What is withheld is the offer to act.
    expect(payload.metadata?.reminderId).toBe("appt-1");
  });

  it("leaves a checkup nudge actionable", async () => {
    // The negative control. Without it the assertion above would still pass
    // against a producer that suppressed every reminder's affordance.
    const { prisma } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].suppressActions).toBeUndefined();
  });

  it("free-text reminder never queries Measurement (matches on LabResult instead)", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({ measurementType: null })],
      // Even if a reading existed, a free-text reminder must not query it —
      // it resolves from a LabResult (D2), and none landed here.
      measurementMatch: { measuredAt: new Date("2026-06-14T18:00:00Z") },
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.autoResolved).toBe(0);
    expect(summary.dispatched).toBe(1);
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
  });

  it("v1.18.1 (D2) — free-text reminder auto-resolves from a matching LabResult", async () => {
    const takenAt = new Date("2026-06-14T18:00:00Z");
    const { prisma, updates } = makePrisma({
      reminders: [reminder({ measurementType: null })],
      labMatch: { takenAt },
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.autoResolved).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].data.lastSatisfiedAt).toEqual(takenAt);
    // A free-text reminder resolves from labs, never from measurements.
    expect(prisma.measurement.findFirst).not.toHaveBeenCalled();
  });

  it("still dispatches under clientManaged — the suppression is APNs-only", async () => {
    // `measurementReminder.clientManaged` suppresses the server's APNs
    // send, which the dispatcher decides per channel. The tick must not
    // pre-empt that decision: a user whose phone owns the local banner
    // still reads Telegram or email on their desktop.
    const { prisma } = makePrisma({
      reminders: [
        reminder({
          measurementType: null,
          user: {
            id: "u1",
            timezone: TZ,
            locale: "de",
            notificationPrefs: { measurementReminder: { clientManaged: true } },
          },
        }),
      ],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(summary.dispatched).toBe(1);
  });

  it("leaves the reminder overdue when the client-managed skip was the only channel", async () => {
    // Nothing delivered, so nothing may be recorded as handled: advancing
    // `nextDueAt` here dropped the reminder out of the Vorsorge card and
    // out of the daily digest, and a preventive-care reminder that never
    // fired was filed as done.
    const { prisma, updates } = makePrisma({
      reminders: [
        reminder({
          measurementType: null,
          user: {
            id: "u1",
            timezone: TZ,
            locale: "de",
            notificationPrefs: { measurementReminder: { clientManaged: true } },
          },
        }),
      ],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => ({
      dispatched: false,
      channelsAttempted: 0,
      channelsSucceeded: 0,
    }));

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.skippedNoChannel).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("bounds the scan with a nextDueAt filter so the index is used", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({})],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    const calls = prisma.measurementReminder.findMany.mock
      .calls as unknown as unknown[][];
    const args = calls[0][0] as {
      where: {
        deletedAt: null;
        enabled: boolean;
        nextDueAt: { not: null; lte: Date };
      };
    };
    expect(args.where.enabled).toBe(true);
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.nextDueAt.not).toBeNull();
    // Floor is now + one tick of slack; anything due (<= floor) is included.
    expect(args.where.nextDueAt.lte.getTime()).toBe(
      NINE_LOCAL.getTime() + 15 * 60_000,
    );
  });

  it("v1.18.0 — skips a glucose reminder when the Glucose module is off, and advances", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [reminder({ measurementType: "BLOOD_GLUCOSE" })],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const isModuleEnabled = vi.fn(async () => false);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch, isModuleEnabled },
    );

    expect(summary.skippedModuleDisabled).toBe(1);
    expect(summary.dispatched).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "glucose");
    // Advances past the cycle so it does not re-evaluate every tick.
    expect(updates).toHaveLength(1);
    expect(updates[0].data.nextDueAt).toBeInstanceOf(Date);
  });

  it("v1.18.0 — still dispatches a glucose reminder when the Glucose module is on", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({ measurementType: "BLOOD_GLUCOSE" })],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const isModuleEnabled = vi.fn(async () => true);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch, isModuleEnabled },
    );

    expect(summary.skippedModuleDisabled).toBe(0);
    expect(summary.dispatched).toBe(1);
    expect(isModuleEnabled).toHaveBeenCalledWith("u1", "glucose");
  });

  it("v1.18.0 — a core-vital (BP) reminder never consults the module gate and dispatches", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({ measurementType: "BLOOD_PRESSURE_SYS" })],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const isModuleEnabled = vi.fn(async () => false); // even if everything is "off"

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch, isModuleEnabled },
    );

    expect(summary.skippedModuleDisabled).toBe(0);
    expect(summary.dispatched).toBe(1);
    // A core domain has no ModuleKey — the gate is never consulted.
    expect(isModuleEnabled).not.toHaveBeenCalled();
  });

  it("skips a reminder outside its notify-hour window", async () => {
    const { prisma } = makePrisma({
      reminders: [reminder({ measurementType: null })],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      new Date("2026-06-15T08:00:00Z"), // 10:00 Berlin — outside the 09 window
      { dispatch },
    );

    expect(summary.skippedOutsideWindow).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // ── v1.39.2 — an open check-up stays due after its reminder ─────────
  //
  // Watched red: with the tick advancing every delivered reminder (the
  // pre-v1.39.2 behaviour), the first two cases fail — the yearly check-up's
  // update carries a `nextDueAt` a year out, and the dashboard and the digest
  // then read the open check-up as scheduled for next year.
  const checkup = (overrides: Partial<FakeReminder> = {}) =>
    reminder({
      measurementType: null,
      intervalDays: null,
      rrule: "FREQ=YEARLY;INTERVAL=1",
      nextDueAt: new Date("2026-06-15T07:00:00Z"), // due today at 09:00
      ...overrides,
    });

  it("keeps a reminded check-up due and records the delivery instead", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [checkup()],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.dispatched).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({ lastNotifiedAt: NINE_LOCAL });
    expect("nextDueAt" in updates[0].data).toBe(false);
  });

  it("keeps a Coach-suggested check-up due the same way", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [checkup({ origin: "COACH" })],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(updates).toHaveLength(1);
    expect("nextDueAt" in updates[0].data).toBe(false);
  });

  it("still rolls a weekly measurement reminder on after its reminder", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [reminder({ origin: "COACH" })],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(updates).toHaveLength(1);
    const advanced = updates[0].data.nextDueAt as Date;
    expect(advanced.getTime()).toBeGreaterThan(NINE_LOCAL.getTime());
    expect(updates[0].data.lastNotifiedAt).toEqual(NINE_LOCAL);
  });

  it("still closes an appointment reminder after its one nudge", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [
        reminder({
          origin: "ENCOUNTER",
          measurementType: null,
          intervalDays: null,
        }),
      ],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(updates).toHaveLength(1);
    expect(updates[0].data.nextDueAt).toBeNull();
  });

  it("does not re-remind an open check-up the day after", async () => {
    const { prisma } = makePrisma({
      reminders: [
        checkup({
          nextDueAt: new Date("2026-06-14T07:00:00Z"),
          lastNotifiedAt: new Date("2026-06-14T07:00:04Z"),
        }),
      ],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.skippedRepeatHeld).toBe(1);
    expect(claimMock).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("holds the repeat for six days and sends it on the seventh", async () => {
    const notifiedAt = new Date("2026-06-08T07:00:04Z");
    const open = checkup({
      nextDueAt: new Date("2026-06-08T07:00:00Z"),
      lastNotifiedAt: notifiedAt,
    });

    const sixDays = makePrisma({ reminders: [open], labMatch: null });
    const heldDispatch = vi.fn<DispatchFn>(async () => OK);
    await runMeasurementReminderTick(
      sixDays.prisma as never,
      new Date("2026-06-14T07:00:00Z"),
      { dispatch: heldDispatch },
    );
    expect(heldDispatch).not.toHaveBeenCalled();

    // Seven calendar days on, at the same notify hour — a few seconds EARLIER
    // on the clock than the first send, which an hour count would still read
    // as "under a week".
    const sevenDays = makePrisma({ reminders: [open], labMatch: null });
    const dispatch = vi.fn<DispatchFn>(async () => OK);
    const summary = await runMeasurementReminderTick(
      sevenDays.prisma as never,
      NINE_LOCAL,
      { dispatch },
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(summary.dispatched).toBe(1);
    expect(sevenDays.updates[0].data).toEqual({ lastNotifiedAt: NINE_LOCAL });
  });

  it("fires on the day a check-up was snoozed to, whatever the last send", async () => {
    // A snooze moves `nextDueAt` past the last send: that is a new slot the
    // person asked for, not a repeat of the old one.
    const { prisma } = makePrisma({
      reminders: [
        checkup({
          nextDueAt: new Date("2026-06-15T07:00:00Z"),
          lastNotifiedAt: new Date("2026-06-14T07:00:04Z"),
        }),
      ],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a one-shot check-up due instead of dropping it", async () => {
    // No cadence at all: rolling it on used to write `nextDueAt: null`, and
    // the open check-up vanished from every surface.
    const { prisma, updates } = makePrisma({
      reminders: [checkup({ rrule: null, intervalDays: null })],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(updates[0].data).toEqual({ lastNotifiedAt: NINE_LOCAL });
  });

  it("rolls a weekly check-up on, since its next slot is the next nudge", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [checkup({ rrule: null, intervalDays: 7 })],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    const advanced = updates[0].data.nextDueAt as Date;
    expect(advanced.getTime()).toBeGreaterThan(NINE_LOCAL.getTime());
  });

  it("keeps a fortnightly check-up due", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [checkup({ rrule: null, intervalDays: 14 })],
      labMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    expect(updates[0].data).toEqual({ lastNotifiedAt: NINE_LOCAL });
  });

  // Watched red: with the rule keyed on `measurementType` (free text only),
  // the first case rolls the questionnaire two weeks forward — exactly the
  // reported pair of screening reminders.
  it("keeps a fortnightly questionnaire due after its reminder", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [
        reminder({
          measurementType: "PHQ9_SCORE",
          intervalDays: 14,
          lastSatisfiedAt: new Date("2026-06-01T07:00:00Z"),
          nextDueAt: new Date("2026-06-15T07:00:00Z"),
        }),
      ],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, {
      dispatch,
      isModuleEnabled: async () => true,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(updates[0].data).toEqual({ lastNotifiedAt: NINE_LOCAL });
  });

  it("holds the repeat of an open measurement reminder too", async () => {
    const { prisma } = makePrisma({
      reminders: [
        reminder({
          measurementType: "WEIGHT",
          intervalDays: 30,
          nextDueAt: new Date("2026-06-14T07:00:00Z"),
          lastNotifiedAt: new Date("2026-06-14T07:00:04Z"),
        }),
      ],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.skippedRepeatHeld).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("satisfies an open measurement reminder from the reading and schedules from it", async () => {
    // Held open since yesterday; the questionnaire lands this morning.
    const filledAt = new Date("2026-06-15T06:30:00Z");
    const { prisma, updates } = makePrisma({
      reminders: [
        reminder({
          measurementType: "GAD7_SCORE",
          intervalDays: 14,
          lastSatisfiedAt: new Date("2026-05-31T07:00:00Z"),
          nextDueAt: new Date("2026-06-14T07:00:00Z"),
          lastNotifiedAt: new Date("2026-06-14T07:00:04Z"),
        }),
      ],
      measurementMatch: { measuredAt: filledAt },
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    const summary = await runMeasurementReminderTick(
      prisma as never,
      NINE_LOCAL,
      { dispatch },
    );

    expect(summary.autoResolved).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(updates[0].data.lastSatisfiedAt).toEqual(filledAt);
    // Fourteen days on from the reading, at the notify hour.
    expect(updates[0].data.nextDueAt).toEqual(new Date("2026-06-29T07:00:00Z"));
  });

  it("rolls a daily course on after its reminder", async () => {
    const { prisma, updates } = makePrisma({
      reminders: [
        reminder({
          origin: "COACH",
          intervalDays: null,
          rrule: "FREQ=DAILY;BYHOUR=9,19",
        }),
      ],
      measurementMatch: null,
    });
    const dispatch = vi.fn<DispatchFn>(async () => OK);

    await runMeasurementReminderTick(prisma as never, NINE_LOCAL, { dispatch });

    // The evening slot of the same day.
    expect(updates[0].data.nextDueAt).toEqual(new Date("2026-06-15T17:00:00Z"));
  });
});
