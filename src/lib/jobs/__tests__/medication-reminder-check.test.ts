/**
 * v1.16.11 (#316) — the medication-reminder tick skips as-needed (PRN)
 * medications at the QUERY level: the candidate read carries
 * `asNeeded: false`, so a PRN medication never reaches the per-schedule
 * loop, never mints a missed-dose row, and never dispatches a phase
 * notification. (Structurally a PRN medication also has zero schedules,
 * so the loop would be a no-op — the predicate keeps it out of the
 * tick's per-medication intake reads entirely.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The intake rows the tick is allowed to see, before its own range filter.
 *
 * The tick reads intakes with a real `scheduledFor` range and suppresses a
 * slot from what comes back. A fake that hands every row over regardless of
 * `where` cannot tell a correct range from a broken one — the suppression
 * assertion stays green either way, which is exactly how a dose logged at
 * 23:50 could keep being reminded after midnight while this file passed. So
 * the fake honours the range the tick actually asks for.
 */
let intakeEvents: Record<string, unknown>[] = [];

function setIntakeEvents(events: Record<string, unknown>[]): void {
  intakeEvents = events;
}

function readIntakeEvents(args?: {
  where?: { scheduledFor?: { gte?: Date; lte?: Date } };
}): Record<string, unknown>[] {
  const range = args?.where?.scheduledFor;
  return intakeEvents.filter((event) => {
    const scheduledFor = event.scheduledFor;
    if (!(scheduledFor instanceof Date)) return true;
    if (range?.gte && scheduledFor.getTime() < range.gte.getTime())
      return false;
    if (range?.lte && scheduledFor.getTime() > range.lte.getTime())
      return false;
    return true;
  });
}

const prismaMock = {
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
    findMany: vi.fn(async (args?: Parameters<typeof readIntakeEvents>[0]) =>
      readIntakeEvents(args),
    ),
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    count: vi.fn().mockResolvedValue(0),
  },
  telegramReminderMessage: {
    findUnique: vi.fn().mockResolvedValue(null),
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
  dispatchNotification: vi.fn().mockResolvedValue({ dispatched: true }),
}));
vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn(() => "token") }));
vi.mock("@/lib/telegram", () => ({ deleteMessage: vi.fn() }));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/notifications/reminder-dedup", () => ({
  claimNotificationEvent: vi.fn().mockResolvedValue(true),
  medicationReminderDedupKey: vi.fn(() => "dedup-key"),
  REMINDER_DEDUP_LOOKBACK_MS: 48 * 60 * 60 * 1000,
}));

import { handleReminderCheck } from "@/lib/jobs/reminder/medication-reminder-check";
import { dispatchNotification } from "@/lib/notifications/dispatcher";

function medicationWithSchedule(
  schedule: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "medication-1",
    name: "Morning tablet",
    dose: null,
    active: true,
    asNeeded: false,
    notificationsEnabled: true,
    snoozedUntil: null,
    startsOn: new Date("2026-07-01T00:00:00.000Z"),
    endsOn: null,
    oneShot: false,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    phaseConfig: null,
    schedules: [
      {
        id: "schedule-1",
        windowStart: "08:00",
        windowEnd: "09:00",
        daysOfWeek: null,
        timesOfDay: ["08:00"],
        reminderGraceMinutes: null,
        rrule: "FREQ=DAILY",
        rollingIntervalDays: null,
        scheduleType: "SCHEDULED",
        cyclicOnWeeks: null,
        cyclicOffWeeks: null,
        doseWindows: null,
        dose: null,
        ...schedule,
      },
    ],
    user: { id: "user-1", timezone: "UTC", locale: "en" },
  };
}

afterEach(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.telegramScheduledDeletion.findMany.mockResolvedValue([]);
  prismaMock.telegramPromptContext.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.medication.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.medication.findMany.mockResolvedValue([]);
  setIntakeEvents([]);
  prismaMock.medicationIntakeEvent.findFirst.mockResolvedValue(null);
  prismaMock.medicationIntakeEvent.create.mockResolvedValue(undefined);
});

describe("handleReminderCheck — telegram prompt-context cleanup (v1.19.0)", () => {
  it("prunes expired force-reply prompt contexts in the same sweep tick", async () => {
    await handleReminderCheck([]);
    expect(prismaMock.telegramPromptContext.deleteMany).toHaveBeenCalledTimes(
      1,
    );
    const arg = prismaMock.telegramPromptContext.deleteMany.mock
      .calls[0][0] as {
      where: { expiresAt: { lte: Date } };
    };
    expect(arg.where.expiresAt.lte).toBeInstanceOf(Date);
  });
});

describe("handleReminderCheck — as-needed skip (v1.16.11, #316)", () => {
  it("queries only active NON-as-needed medications", async () => {
    await handleReminderCheck([]);

    expect(prismaMock.medication.findMany).toHaveBeenCalledTimes(1);
    const args = prismaMock.medication.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    // v1.39.1 (#1033) — nor a medication with intake tracking off.
    expect(args.where).toEqual({
      active: true,
      asNeeded: false,
      trackIntake: true,
    });
  });

  it("dispatches nothing when the candidate set is empty", async () => {
    await handleReminderCheck([]);
    expect(dispatchNotification).not.toHaveBeenCalled();
    expect(prismaMock.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });
});

describe("handleReminderCheck per-slot reminder windows", () => {
  it("escalates a morning slot independently of a distant evening sibling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({
        windowEnd: "18:00",
        timesOfDay: ["08:00", "18:00"],
      }),
    ] as never);
    setIntakeEvents([]);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          phase: "ORANGE",
          timeOfDay: "08:00",
        }),
      }),
    );
  });

  it("uses an explicit range as bounds instead of a duration anchored at the slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({
        windowEnd: "18:00",
        timesOfDay: ["08:00", "18:00"],
        doseWindows: [{ timeOfDay: "08:00", start: "07:30", end: "09:30" }],
      }),
    ] as never);
    setIntakeEvents([]);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          phase: "YELLOW",
          timeOfDay: "08:00",
        }),
      }),
    );
  });

  it("suppresses a slot for a late intake attributed by the shared dose band", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({}),
    ] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: new Date("2026-07-28T08:45:00.000Z"),
        skipped: false,
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

describe("handleReminderCheck medication-wide slot attribution", () => {
  it("lets an overlapping schedule claim the nearest medication-wide slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    const medication = medicationWithSchedule({}) as {
      schedules: Record<string, unknown>[];
    };
    medication.schedules = [
      medication.schedules[0],
      {
        ...medication.schedules[0],
        id: "schedule-2",
        windowStart: "09:00",
        windowEnd: "10:00",
        timesOfDay: ["09:00"],
      },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T09:00:00.000Z"),
        takenAt: new Date("2026-07-28T08:50:00.000Z"),
        skipped: false,
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ timeOfDay: "08:00" }),
      }),
    );
  });

  it("keeps same-time band attribution on the owning schedule row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:45:00.000Z"));
    const medication = medicationWithSchedule({
      doseWindows: [{ timeOfDay: "08:00", start: "07:00", end: "08:00" }],
    }) as {
      schedules: Record<string, unknown>[];
    };
    medication.schedules = [
      medication.schedules[0],
      {
        ...medication.schedules[0],
        id: "schedule-2",
        doseWindows: [{ timeOfDay: "08:00", start: "08:30", end: "09:30" }],
      },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: new Date("2026-07-28T08:45:00.000Z"),
        skipped: false,
        attributionSource: "AUTO",
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ scheduleId: "schedule-1" }),
      }),
    );
  });

  it("suppresses an open rolling occurrence for a skipped scheduled slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({
        rrule: null,
        rollingIntervalDays: 7,
      }),
    ] as never);
    prismaMock.medicationIntakeEvent.findFirst.mockResolvedValue({
      takenAt: new Date("2026-07-21T08:00:00.000Z"),
    });
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: null,
        skipped: true,
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("suppresses the effective windowStart slot for an empty legacy row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T08:30:00.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({
        rrule: null,
        daysOfWeek: null,
        timesOfDay: [],
      }),
    ] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: new Date("2026-07-28T08:10:00.000Z"),
        skipped: false,
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("binds a skipped event to scheduledFor instead of a neighbouring band", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    const medication = medicationWithSchedule({
      doseWindows: [{ timeOfDay: "08:00", start: "09:00", end: "10:00" }],
    }) as {
      schedules: Record<string, unknown>[];
    };
    medication.schedules = [
      medication.schedules[0],
      {
        ...medication.schedules[0],
        id: "schedule-2",
        windowStart: "09:00",
        windowEnd: "10:00",
        timesOfDay: ["09:00"],
        doseWindows: null,
      },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: null,
        skipped: true,
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ timeOfDay: "09:00" }),
      }),
    );
  });

  it("binds an off-band USER_PIN take to its stored slot anchor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({}),
    ] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: new Date("2026-07-28T13:00:00.000Z"),
        skipped: false,
        attributionSource: "USER_PIN",
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("lets one sub-minute-drift skip claim only one colliding schedule row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    const medication = medicationWithSchedule({}) as {
      schedules: Record<string, unknown>[];
    };
    medication.schedules = [
      medication.schedules[0],
      {
        ...medication.schedules[0],
        id: "schedule-2",
      },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:30.000Z"),
        takenAt: null,
        skipped: true,
        attributionSource: "AUTO",
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
  });

  it("does not let a pre-edit action suppress a current-era slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:15:00.000Z"));
    const medication = medicationWithSchedule({
      windowStart: "10:00",
      windowEnd: "11:00",
      timesOfDay: ["10:00"],
      rrule: "FREQ=WEEKLY;BYDAY=TU",
    });
    medication.scheduleRevisions = [
      { validUntil: new Date("2026-07-28T08:30:00.000Z") },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: new Date("2026-07-28T08:00:00.000Z"),
        createdAt: new Date("2026-07-28T08:00:00.000Z"),
        skipped: false,
        attributionSource: "AUTO",
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
  });

  it("lets a post-edit action suppress the current-era slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:15:00.000Z"));
    const medication = medicationWithSchedule({
      windowStart: "10:00",
      windowEnd: "11:00",
      timesOfDay: ["10:00"],
      rrule: "FREQ=WEEKLY;BYDAY=TU",
    });
    medication.scheduleRevisions = [
      { validUntil: new Date("2026-07-28T08:30:00.000Z") },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T08:00:00.000Z"),
        takenAt: new Date("2026-07-28T09:00:00.000Z"),
        createdAt: new Date("2026-07-28T09:00:00.000Z"),
        skipped: false,
        attributionSource: "AUTO",
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("does not remind a current schedule slot from before its live era", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T13:30:00.000Z"));
    const medication = medicationWithSchedule({
      windowStart: "08:00",
      windowEnd: "18:00",
      timesOfDay: ["08:00", "18:00"],
    });
    medication.scheduleRevisions = [
      { validUntil: new Date("2026-07-28T08:30:00.000Z") },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
    expect(prismaMock.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("uses a post-edit skip mutation to suppress the current-era slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:15:00.000Z"));
    const medication = medicationWithSchedule({
      windowStart: "10:00",
      windowEnd: "11:00",
      timesOfDay: ["10:00"],
    });
    medication.scheduleRevisions = [
      { validUntil: new Date("2026-07-28T08:30:00.000Z") },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T10:00:00.000Z"),
        takenAt: null,
        createdAt: new Date("2026-07-28T08:00:00.000Z"),
        updatedAt: new Date("2026-07-28T09:00:00.000Z"),
        skipped: true,
        attributionSource: "AUTO",
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("uses a post-edit USER_PIN mutation to suppress the current-era slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:15:00.000Z"));
    const medication = medicationWithSchedule({
      windowStart: "10:00",
      windowEnd: "11:00",
      timesOfDay: ["10:00"],
    });
    medication.scheduleRevisions = [
      { validUntil: new Date("2026-07-28T08:30:00.000Z") },
    ];
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T10:00:00.000Z"),
        takenAt: new Date("2026-07-28T08:00:00.000Z"),
        createdAt: new Date("2026-07-28T08:00:00.000Z"),
        updatedAt: new Date("2026-07-28T09:00:00.000Z"),
        skipped: false,
        attributionSource: "USER_PIN",
      },
    ]);

    await handleReminderCheck([]);

    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

describe("handleReminderCheck configured wall-clock phase bounds", () => {
  it("honours an explicit range that does not contain the nominal slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:00.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({
        doseWindows: [{ timeOfDay: "08:00", start: "09:00", end: "10:00" }],
      }),
    ] as never);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          phase: "GREEN",
          timeOfDay: "08:00",
        }),
      }),
    );
  });

  it("resolves a DST-spanning phase end in the user's wall clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T01:15:00.000Z")); // 03:15 CEST
    const medication = medicationWithSchedule({
      windowStart: "01:30",
      windowEnd: "03:30",
      timesOfDay: ["01:30"],
    }) as {
      startsOn: Date;
      createdAt: Date;
      user: { id: string; timezone: string; locale: string };
    };
    medication.startsOn = new Date("2026-03-01T00:00:00.000Z");
    medication.createdAt = new Date("2026-03-01T00:00:00.000Z");
    medication.user.timezone = "Europe/Berlin";
    prismaMock.medication.findMany.mockResolvedValue([medication] as never);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          phase: "YELLOW",
          timeOfDay: "01:30",
        }),
      }),
    );
  });

  it("rounds fractional countdown minutes up in user-facing text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T09:15:30.000Z"));
    prismaMock.medication.findMany.mockResolvedValue([
      medicationWithSchedule({
        windowStart: "09:00",
        windowEnd: "10:00",
        timesOfDay: ["09:00"],
      }),
    ] as never);

    await handleReminderCheck([]);

    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("45 min"),
      }),
    );
  });
});

describe("issue #664 — exact occurrence identity survives local midnight", () => {
  function crossMidnightMedication(timezone: string) {
    const medication = medicationWithSchedule({
      windowStart: "23:45",
      windowEnd: "00:30",
      timesOfDay: ["23:45"],
      rrule: "FREQ=DAILY",
    }) as {
      user: { id: string; timezone: string; locale: string };
    };
    medication.user.timezone = timezone;
    return medication;
  }

  it.each([
    {
      label: "UTC",
      timezone: "UTC",
      occurrence: "2026-07-28T23:45:00.000Z",
      tick: "2026-07-29T00:15:00.000Z",
    },
    {
      label: "Berlin summer time",
      timezone: "Europe/Berlin",
      occurrence: "2026-07-28T21:45:00.000Z",
      tick: "2026-07-28T22:15:00.000Z",
    },
    {
      label: "Berlin DST fall-back eve",
      timezone: "Europe/Berlin",
      occurrence: "2026-10-24T21:45:00.000Z",
      tick: "2026-10-24T22:15:00.000Z",
    },
    {
      label: "positive-offset Auckland",
      timezone: "Pacific/Auckland",
      occurrence: "2026-07-28T11:45:00.000Z",
      tick: "2026-07-28T12:15:00.000Z",
    },
  ])(
    "keeps an untaken $label 23:45 occurrence actionable after midnight",
    async ({ timezone, occurrence, tick }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(tick));
      prismaMock.medication.findMany.mockResolvedValue([
        crossMidnightMedication(timezone),
      ] as never);
      setIntakeEvents([]);

      await handleReminderCheck([]);

      expect(dispatchNotification).toHaveBeenCalledTimes(1);
      expect(dispatchNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            scheduledAt: occurrence,
            timeOfDay: "23:45",
          }),
        }),
      );
    },
  );

  it("reads and suppresses the prior-day occurrence, but not tomorrow's distinct dose", async () => {
    vi.useFakeTimers();
    const priorOccurrence = new Date("2026-07-28T21:45:00.000Z");
    const action = {
      scheduledFor: priorOccurrence,
      takenAt: new Date("2026-07-28T21:50:00.000Z"),
      skipped: false,
      attributionSource: "AUTO",
      updatedAt: new Date("2026-07-28T21:50:00.000Z"),
    };
    prismaMock.medication.findMany.mockResolvedValue([
      crossMidnightMedication("Europe/Berlin"),
    ] as never);
    setIntakeEvents([action]);

    vi.setSystemTime(new Date("2026-07-28T22:15:00.000Z")); // 00:15 Jul 29
    await handleReminderCheck([]);
    expect(dispatchNotification).not.toHaveBeenCalled();

    const postMidnightRead = prismaMock.medicationIntakeEvent.findMany.mock
      .calls[0][0] as {
      where: { scheduledFor: { gte: Date; lte: Date } };
    };
    expect(
      postMidnightRead.where.scheduledFor.gte.getTime(),
    ).toBeLessThanOrEqual(priorOccurrence.getTime());
    expect(
      postMidnightRead.where.scheduledFor.lte.getTime(),
    ).toBeGreaterThanOrEqual(priorOccurrence.getTime());

    vi.setSystemTime(new Date("2026-07-29T21:50:00.000Z")); // 23:50 Jul 29
    await handleReminderCheck([]);
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          scheduledAt: "2026-07-29T21:45:00.000Z",
        }),
      }),
    );
  });

  it("still escalates a genuinely missed 23:45 dose hours after midnight", async () => {
    // The other direction of the same boundary, and the one that costs a
    // person a dose rather than a night's sleep: quietening the repeat must
    // not quieten the escalation. 04:30 Berlin on Jul 29 is 240 minutes past
    // the Jul 28 window's end, so the untaken dose reaches RED — and both the
    // missed-intake row and the notification must name the Jul 28 slot, not
    // the day the tick happens to run on.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T02:30:00.000Z")); // 04:30 Jul 29
    prismaMock.medication.findMany.mockResolvedValue([
      crossMidnightMedication("Europe/Berlin"),
    ] as never);
    setIntakeEvents([]);

    await handleReminderCheck([]);

    expect(prismaMock.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.medicationIntakeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledFor: new Date("2026-07-28T21:45:00.000Z"),
          takenAt: null,
          skipped: false,
          source: "REMINDER",
        }),
      }),
    );
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          phase: "RED",
          scheduledAt: "2026-07-28T21:45:00.000Z",
          date: "2026-07-28",
        }),
      }),
    );
  });

  it("does not mint a second missed row for a dose taken just before midnight", async () => {
    // The RED placeholder is the escalation's permanent trace: mint it for a
    // dose the user already logged and the medication reads as missed forever
    // after, in compliance and in every history surface.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T02:30:00.000Z")); // 04:30 Jul 29
    prismaMock.medication.findMany.mockResolvedValue([
      crossMidnightMedication("Europe/Berlin"),
    ] as never);
    setIntakeEvents([
      {
        scheduledFor: new Date("2026-07-28T21:45:00.000Z"),
        takenAt: new Date("2026-07-28T21:50:00.000Z"),
        skipped: false,
        attributionSource: "AUTO",
        updatedAt: new Date("2026-07-28T21:50:00.000Z"),
      },
    ]);

    await handleReminderCheck([]);

    expect(prismaMock.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});
