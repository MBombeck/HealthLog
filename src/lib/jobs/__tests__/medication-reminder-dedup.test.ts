/**
 * Medication-reminder dedup + client-managed contract.
 *
 * Two behaviours are pinned here, both of them user-visible failures
 * before this suite existed:
 *
 *  1. **One dispatch per (medication, slot, phase, local day).** The
 *     dedup used to key on the Telegram message ledger, which is written
 *     only when a Telegram send succeeds. A user on email / APNs / ntfy
 *     therefore never had a ledger row, so the 15-minute tick re-fired the
 *     same overdue notice for the rest of the day — roughly fifty mails per
 *     missed dose. The anchor now lives in `notification_events` and is written
 *     for every dispatched slot regardless of channel outcome.
 *
 *  2. **Coarser must not mean quieter.** The dedup is per phase and per
 *     local day: the ORANGE → RED escalation still fires, and the next
 *     day starts clean. That direction is the whole risk of the fix, so it
 *     is asserted explicitly rather than implied.
 *
 * The tick reads the wall clock itself, so the fixture drives it with a
 * faked system time and a hand-rolled Prisma surface (no testcontainer).
 * All instants are UTC and the fixture user's timezone is UTC, so the
 * suite is identical under any `TZ`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

interface FakeNotificationEvent {
  recordUserId: string;
  eventType: string;
  dedupKey: string;
  createdAt: Date;
}

const notificationEvents: FakeNotificationEvent[] = [];

const prismaMock = {
  $queryRaw: vi.fn().mockResolvedValue([{ locked: 1 }]),
  $transaction: vi.fn(),
  telegramScheduledDeletion: {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  telegramPromptContext: {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  },
  medication: {
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
  },
  medicationIntakeEvent: {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockResolvedValue({}),
  },
  telegramReminderMessage: {
    findUnique: vi.fn().mockResolvedValue(null),
  },
  notificationEvent: {
    create: vi.fn(
      async ({ data }: { data: Omit<FakeNotificationEvent, "createdAt"> }) => {
        notificationEvents.push({ ...data, createdAt: new Date() });
        return { id: `ne-${notificationEvents.length}` };
      },
    ),
    findFirst: vi.fn(
      async ({
        where,
      }: {
        where: {
          recordUserId: string;
          eventType: string;
          dedupKey: string;
          createdAt?: { gte: Date };
        };
      }) =>
        notificationEvents.find(
          (row) =>
            row.recordUserId === where.recordUserId &&
            row.eventType === where.eventType &&
            row.dedupKey === where.dedupKey &&
            (where.createdAt?.gte === undefined ||
              row.createdAt >= where.createdAt.gte),
        ) ?? null,
    ),
  },
  user: {
    findFirst: vi.fn().mockResolvedValue(null),
  },
};

vi.mock("@/lib/jobs/reminder/shared", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/jobs/reminder/shared")>();
  return {
    ...actual,
    getWorkerPrisma: () => prismaMock,
    workerLog: vi.fn(),
  };
});
vi.mock("@/lib/jobs/worker-status", () => ({
  recordError: vi.fn(),
  recordReminderCheck: vi.fn(),
  markWorkerStarted: vi.fn(),
}));
vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: vi.fn(
    async (
      _name: string,
      fn: (evt: {
        addMeta: (k: string, v: unknown) => void;
        addWarning: (m: string) => void;
        setError: (e: unknown) => void;
      }) => Promise<void>,
    ) => fn({ addMeta: vi.fn(), addWarning: vi.fn(), setError: vi.fn() }),
  ),
}));
vi.mock("@/lib/notifications/dispatcher", () => ({
  dispatchNotification: vi.fn().mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  }),
}));
vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn(() => "token") }));
vi.mock("@/lib/telegram", () => ({ deleteMessage: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn().mockResolvedValue(true),
}));

import { handleReminderCheck } from "@/lib/jobs/reminder/medication-reminder-check";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

/** One 08:00–09:00 slot, every day, notifications on, no Telegram anywhere. */
function medicationFixture(notificationPrefs: unknown = null) {
  return {
    id: "med-1",
    name: "Fixture",
    dose: "1",
    active: true,
    asNeeded: false,
    notificationsEnabled: true,
    // The reminder gate reads the full row.
    autoMarkTaken: false,
    trackIntake: true,
    snoozedUntil: null,
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    phaseConfig: null,
    schedules: [
      {
        id: "sched-1",
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        timesOfDay: [],
        reminderGraceMinutes: null,
        rrule: null,
        rollingIntervalDays: null,
        scheduleType: "SCHEDULED",
        cyclicOnWeeks: null,
        cyclicOffWeeks: null,
        doseWindows: null,
        dose: null,
      },
    ],
    user: {
      id: "user-1",
      timezone: "UTC",
      locale: "en",
      notificationPrefs,
    },
  };
}

/** Phases dispatched so far, in order. */
function dispatchedPhases(): string[] {
  return vi
    .mocked(dispatchNotification)
    .mock.calls.map(
      (call) =>
        (call[0].metadata as { phase: string } | undefined)?.phase ?? "",
    );
}

async function tickAt(iso: string): Promise<void> {
  vi.setSystemTime(new Date(iso));
  await handleReminderCheck([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  notificationEvents.length = 0;
  prismaMock.$transaction.mockImplementation(async (run) => run(prismaMock));
  vi.useFakeTimers();
  prismaMock.telegramScheduledDeletion.findMany.mockResolvedValue([]);
  prismaMock.telegramPromptContext.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.medication.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
  prismaMock.medicationIntakeEvent.count.mockResolvedValue(0);
  prismaMock.telegramReminderMessage.findUnique.mockResolvedValue(null);
  vi.mocked(dispatchNotification).mockResolvedValue({
    dispatched: true,
    channelsAttempted: 1,
    channelsSucceeded: 1,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("medication reminder — one dispatch per slot, phase and local day", () => {
  it("dispatches the overdue notice once across repeated ticks in the same phase", async () => {
    prismaMock.medication.findMany.mockResolvedValue([medicationFixture()]);

    // Four ticks, 15 minutes apart, all inside the ORANGE phase of the
    // 08:00–09:00 slot. The pre-fix worker sent one notification per tick.
    await tickAt("2026-06-15T09:15:00Z");
    await tickAt("2026-06-15T09:30:00Z");
    await tickAt("2026-06-15T09:45:00Z");
    await tickAt("2026-06-15T10:00:00Z");

    expect(dispatchedPhases()).toEqual(["ORANGE"]);
  });

  it("still escalates to the next phase on the same day", async () => {
    prismaMock.medication.findMany.mockResolvedValue([medicationFixture()]);

    await tickAt("2026-06-15T09:15:00Z"); // ORANGE
    await tickAt("2026-06-15T09:30:00Z"); // ORANGE again — suppressed
    await tickAt("2026-06-15T13:00:00Z"); // 240 min past window end → RED

    expect(dispatchedPhases()).toEqual(["ORANGE", "RED"]);
  });

  it("starts clean on the next local day", async () => {
    prismaMock.medication.findMany.mockResolvedValue([medicationFixture()]);

    await tickAt("2026-06-15T09:15:00Z");
    await tickAt("2026-06-15T13:00:00Z");
    await tickAt("2026-06-16T09:15:00Z");
    await tickAt("2026-06-16T09:30:00Z");

    expect(dispatchedPhases()).toEqual(["ORANGE", "RED", "ORANGE"]);
  });

  it("suppresses the repeat even when no channel delivered", async () => {
    // The anchor is written per dispatched slot, not per successful send.
    // Anchoring on success would re-fire every 15 minutes against a broken
    // channel — the same flood wearing a different key.
    prismaMock.medication.findMany.mockResolvedValue([medicationFixture()]);
    vi.mocked(dispatchNotification).mockResolvedValue({
      dispatched: false,
      channelsAttempted: 1,
      channelsSucceeded: 0,
    });

    await tickAt("2026-06-15T09:15:00Z");
    await tickAt("2026-06-15T09:30:00Z");
    await tickAt("2026-06-15T09:45:00Z");

    expect(dispatchedPhases()).toEqual(["ORANGE"]);
  });

  it("does not let one slot's anchor silence a second slot of the same medication", async () => {
    // Two legacy single-window schedules on one medication: both carry an
    // empty first-class `timesOfDay`, so a dedup key built from the dedup
    // placeholder alone would collapse the evening dose into the morning one.
    const med = medicationFixture();
    med.schedules.push({
      ...med.schedules[0],
      id: "sched-2",
      windowStart: "20:00",
      windowEnd: "21:00",
    });
    prismaMock.medication.findMany.mockResolvedValue([med]);

    await tickAt("2026-06-15T09:15:00Z"); // morning slot, ORANGE
    await tickAt("2026-06-15T21:15:00Z"); // morning RED + evening ORANGE

    const slots = vi.mocked(dispatchNotification).mock.calls.map((call) => {
      const meta = call[0].metadata as { scheduleId: string; phase: string };
      return `${meta.scheduleId}:${meta.phase}`;
    });
    expect(slots).toEqual(["sched-1:ORANGE", "sched-1:RED", "sched-2:ORANGE"]);
  });
});

describe("medication reminder — client-managed suppression is APNs-only", () => {
  it("still dispatches so the user's other channels deliver", async () => {
    // `medication.clientManaged` means the iOS client owns the local
    // banner. It never meant "stop telling me on Telegram / email"; the
    // published contract has always said APNs. The suppression now happens
    // in the dispatcher's APNs branch, so the dispatch itself must proceed.
    prismaMock.medication.findMany.mockResolvedValue([
      medicationFixture({ medication: { clientManaged: true } }),
    ]);

    await tickAt("2026-06-15T09:15:00Z");

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchedPhases()).toEqual(["ORANGE"]);
  });

  it("keeps the per-slot dedup for a client-managed user", async () => {
    prismaMock.medication.findMany.mockResolvedValue([
      medicationFixture({ medication: { deliveryDefault: "client" } }),
    ]);

    await tickAt("2026-06-15T09:15:00Z");
    await tickAt("2026-06-15T09:30:00Z");

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
  });
});

describe("issue #664 — dedup follows the scheduled occurrence across midnight", () => {
  it("dispatches an untreated overnight occurrence once and anchors its own local date", async () => {
    const med = medicationFixture();
    Object.assign(med.schedules[0], {
      windowStart: "23:45",
      windowEnd: "00:30",
      timesOfDay: ["23:45"],
      rrule: "FREQ=DAILY",
    });
    med.user.timezone = "Europe/Berlin";
    prismaMock.medication.findMany.mockResolvedValue([med]);

    // 00:15 and 00:30 on Jul 29 in Berlin are still the Jul 28 23:45
    // occurrence's open window.
    await tickAt("2026-07-28T22:15:00.000Z");
    await tickAt("2026-07-28T22:30:00.000Z");

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(notificationEvents).toHaveLength(1);
    expect(notificationEvents[0]?.dedupKey).toBe(
      "med:med-1:sched-1:23:45:YELLOW:2026-07-28",
    );
  });

  it("keeps consecutive 23:45 occurrences distinct", async () => {
    const { medicationReminderDedupKey } =
      await import("@/lib/notifications/reminder-dedup");
    const first = medicationReminderDedupKey({
      medicationId: "med-1",
      scheduleId: "sched-1",
      slotTime: "23:45",
      phase: "YELLOW",
      localDate: "2026-07-28",
    });
    const second = medicationReminderDedupKey({
      medicationId: "med-1",
      scheduleId: "sched-1",
      slotTime: "23:45",
      phase: "YELLOW",
      localDate: "2026-07-29",
    });

    expect(first).not.toBe(second);
  });
});
