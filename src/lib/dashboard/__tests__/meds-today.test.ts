/**
 * `buildMedsTodayBlock` — integration-style unit tests with a mocked
 * Prisma client and a mocked projector.
 *
 * Pinned contracts:
 *   - the idempotent projection runs BEFORE the today-window read (so
 *     the tally always sees the freshly minted pending rows) with the
 *     user's local-day bounds;
 *   - the tally semantics match the summary route's compliance tile
 *     exactly (taken = `takenAt` set and not skipped);
 *   - the next-due pick is each medication's next dose by the dose
 *     resolver over its ledger (real ledger and band minter, no engine
 *     mocks), the earliest across active medications;
 *   - an open slot past its on-time window surfaces with
 *     `nextDueOverdue: true`, and a recorded slot advances to the next one;
 *   - the today window is computed in the USER's timezone (asserted on
 *     the where-clause bounds for a non-European zone).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const projectTodayIntakesAndRecompute = vi.fn();

vi.mock("@/lib/medications/scheduling/project-today-intakes", () => ({
  projectTodayIntakesAndRecompute: (...a: unknown[]) =>
    projectTodayIntakesAndRecompute(...a),
}));

vi.mock("@/lib/db", () => ({
  get prisma() {
    return fakePrisma;
  },
}));

import { buildMedsTodayBlock } from "../meds-today";

/** Noon Berlin (CEST) on a fixed summer day. */
const NOW = new Date("2026-06-10T10:00:00.000Z");
const BERLIN = "Europe/Berlin";

interface FakeIntakeRow {
  medicationId?: string;
  scheduledFor?: Date;
  takenAt: Date | null;
  skipped: boolean;
}

function dailySchedule(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "sched-1",
    medicationId: "med-1",
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
    ...overrides,
  };
}

function medication(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "med-1",
    name: "Testmittel",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    endedAt: null,
    trackIntake: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schedules: [dailySchedule()],
    scheduleRevisions: [],
    courses: [],
    ...overrides,
  };
}

/** Call-order ledger so the projection-before-read contract is assertable. */
let callOrder: string[];
let medications: Array<Record<string, unknown>>;
let todayRows: FakeIntakeRow[];
let resolvedRows: Array<{
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
}>;
let capturedTodayWhere: Record<string, unknown> | null;

const fakePrisma = {
  medication: {
    findMany: vi.fn(async () => {
      callOrder.push("medication.findMany");
      return medications;
    }),
  },
  medicationIntakeEvent: {
    // One medication's anchor read (the newest take before the window).
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(
      async (args: { where: { OR?: unknown; scheduledFor?: unknown } }) => {
        if (args.where.OR) {
          // The dose ledger's window read.
          callOrder.push("ledger.findMany");
          return resolvedRows.map((r, i) => ({
            id: `intake-${i}`,
            medicationId: r.medicationId,
            scheduledFor: r.scheduledFor,
            takenAt: r.takenAt,
            skipped: false,
            autoMissed: false,
            attributionSource: null,
            doseTaken: null,
            source: "WEB",
            autoRecorded: false,
          }));
        }
        callOrder.push("today.findMany");
        capturedTodayWhere = args.where as Record<string, unknown>;
        return todayRows;
      },
    ),
  },
  // The dose ledger's anchor read (the newest take before the window).
  $queryRaw: vi.fn(async () => []),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
  medications = [];
  todayRows = [];
  resolvedRows = [];
  capturedTodayWhere = null;
  projectTodayIntakesAndRecompute.mockImplementation(async () => {
    callOrder.push("project");
    return { projected: 0, backfilled: 0, slotKeys: new Set<string>() };
  });
});

describe("buildMedsTodayBlock — projection contract", () => {
  it("projects the user's local today BEFORE every read (idempotency seam)", async () => {
    await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    expect(projectTodayIntakesAndRecompute).toHaveBeenCalledTimes(1);
    const arg = projectTodayIntakesAndRecompute.mock.calls[0][0] as {
      userId: string;
      userTz: string;
      todayStart: Date;
      todayEnd: Date;
    };
    expect(arg.userId).toBe("user-1");
    expect(arg.userTz).toBe(BERLIN);
    // Berlin local midnight (CEST = UTC+2) → 22:00Z the prior evening.
    expect(arg.todayStart.toISOString()).toBe("2026-06-09T22:00:00.000Z");
    expect(arg.todayEnd.toISOString()).toBe("2026-06-10T22:00:00.000Z");

    // Projection strictly first — the tally must see the minted rows.
    expect(callOrder[0]).toBe("project");
    expect(callOrder.slice(1)).toContain("today.findMany");
  });

  it("computes the today window in the user's zone, not the server's", async () => {
    // Pacific/Auckland (UTC+12, no DST in June): 10:00Z = 22:00 local,
    // so local-today spans [2026-06-09T12:00Z, 2026-06-10T12:00Z).
    await buildMedsTodayBlock(fakePrisma, "user-1", "Pacific/Auckland", NOW);

    const where = capturedTodayWhere as {
      scheduledFor: { gte: Date; lt: Date };
      deletedAt: null;
    };
    expect(where.scheduledFor.gte.toISOString()).toBe(
      "2026-06-09T12:00:00.000Z",
    );
    expect(where.scheduledFor.lt.toISOString()).toBe(
      "2026-06-10T12:00:00.000Z",
    );
    expect(where.deletedAt).toBeNull();
  });
});

describe("buildMedsTodayBlock — the 25-hour day", () => {
  it("covers the last local hour on the day the clocks go back", async () => {
    // 2026-10-25 in Berlin runs 25 hours: CEST midnight is 22:00Z the
    // evening before, the next CET midnight 23:00Z. A dose at 23:30 local
    // (22:30Z) lies inside the day and must be counted.
    const dstNow = new Date("2026-10-25T20:00:00.000Z");
    await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, dstNow);

    const arg = projectTodayIntakesAndRecompute.mock.calls[0][0] as {
      todayStart: Date;
      todayEnd: Date;
    };
    expect(arg.todayStart.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(arg.todayEnd.toISOString()).toBe("2026-10-25T23:00:00.000Z");

    const where = capturedTodayWhere as {
      scheduledFor: { gte: Date; lt: Date };
    };
    expect(where.scheduledFor.lt.toISOString()).toBe(
      "2026-10-25T23:00:00.000Z",
    );
    expect(
      where.scheduledFor.lt.getTime() >
        new Date("2026-10-25T22:30:00.000Z").getTime(),
    ).toBe(true);
  });
});

describe("buildMedsTodayBlock — tally", () => {
  it("counts scheduled / taken / skipped, leaving an ad-hoc take out", async () => {
    const slot = (iso: string) => new Date(iso);
    todayRows = [
      {
        takenAt: new Date("2026-06-10T06:05:00.000Z"),
        skipped: false,
        scheduledFor: slot("2026-06-10T06:00:00.000Z"),
      },
      // an ad-hoc take (stored on its own instant): not a scheduled dose
      {
        takenAt: new Date("2026-06-10T08:00:00.000Z"),
        skipped: false,
        scheduledFor: slot("2026-06-10T08:00:00.000Z"),
      },
      // deliberate skip
      {
        takenAt: null,
        skipped: true,
        scheduledFor: slot("2026-06-10T12:00:00.000Z"),
      },
      // still-open pending
      {
        takenAt: null,
        skipped: false,
        scheduledFor: slot("2026-06-10T04:00:00.000Z"),
      },
    ];

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    expect(block.scheduledToday).toBe(3);
    expect(block.takenToday).toBe(1);
    expect(block.skippedToday).toBe(1);
    // The slot instants the Today fact checks against its own clock (#173).
    expect(block.scheduledTodayAt).toEqual([
      "2026-06-10T04:00:00.000Z",
      "2026-06-10T06:00:00.000Z",
      "2026-06-10T12:00:00.000Z",
    ]);
  });

  it("tallies only the scheduled doses of tracked medications", async () => {
    // The row-level cases run against Postgres in
    // tests/integration/meds-today-scheduled-total.test.ts.
    await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);
    expect(capturedTodayWhere).toMatchObject({
      medication: { trackIntake: true, asNeeded: false },
      AND: [
        {
          OR: [
            { takenAt: { not: null } },
            { skipped: true },
            { autoMissed: true },
            { medication: { active: true } },
          ],
        },
      ],
    });
  });

  it("returns a zeroed block for an account with no medications", async () => {
    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);
    expect(block).toEqual({
      activeCount: 0,
      scheduledToday: 0,
      takenToday: 0,
      skippedToday: 0,
      scheduledTodayAt: [],
      nextDueAt: null,
      nextDueOverdue: false,
      nextDueMedicationName: null,
      nextDueMedicationId: null,
      dueCandidates: [],
    });
  });

  it("reads only ACTIVE medications", async () => {
    await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);
    const arg = fakePrisma.medication.findMany.mock.calls[0][0] as {
      where: { userId: string; active: boolean };
    };
    // v1.39.1 (#1033) — and only medications whose intake is tracked.
    expect(arg.where).toEqual({
      userId: "user-1",
      active: true,
      trackIntake: true,
    });
  });
});

describe("buildMedsTodayBlock — next due (dose resolver)", () => {
  it("picks the EARLIEST future slot across medications, with its name", async () => {
    // 18:00 Berlin = 16:00Z; 20:00 Berlin = 18:00Z. Yesterday's slots
    // are past their catch-up bands (daily tail 4 h), so the engine
    // lands on today's anchors.
    medications = [
      medication({
        id: "med-late",
        name: "Spätmittel",
        schedules: [
          dailySchedule({
            id: "sched-late",
            medicationId: "med-late",
            windowStart: "20:00",
            windowEnd: "21:00",
            timesOfDay: ["20:00"],
          }),
        ],
      }),
      medication({
        id: "med-evening",
        name: "Abendmittel",
        schedules: [
          dailySchedule({
            id: "sched-evening",
            medicationId: "med-evening",
            windowStart: "18:00",
            windowEnd: "19:00",
            timesOfDay: ["18:00"],
          }),
        ],
      }),
    ];

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    expect(block.activeCount).toBe(2);
    expect(block.nextDueAt).toBe("2026-06-10T16:00:00.000Z");
    expect(block.nextDueOverdue).toBe(false);
    expect(block.nextDueMedicationName).toBe("Abendmittel");
    expect(block.nextDueMedicationId).toBe("med-evening");
  });

  it("calls a dose due inside its on-time window, overdue past it", async () => {
    // Now is 12:00 Berlin (10:00Z). The 11:00 dose (09:00Z) with its window
    // to 12:00 is still due; the 09:00 dose (07:00Z) with its window to
    // 10:00 is overdue, inside the daily catch-up band. The overdue one leads.
    medications = [
      medication({
        id: "med-noon",
        name: "Mittagsmittel",
        schedules: [
          dailySchedule({
            id: "sched-noon",
            medicationId: "med-noon",
            windowStart: "11:00",
            windowEnd: "12:00",
            timesOfDay: ["11:00"],
          }),
        ],
      }),
      medication({
        id: "med-morning",
        name: "Morgenmittel",
        schedules: [
          dailySchedule({
            id: "sched-morning",
            medicationId: "med-morning",
            windowStart: "09:00",
            windowEnd: "10:00",
            timesOfDay: ["09:00"],
          }),
        ],
      }),
    ];

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    const byId = new Map(
      (block.dueCandidates ?? []).map((c) => [c.medicationId, c]),
    );
    expect(byId.get("med-noon")).toMatchObject({
      dueAt: "2026-06-10T09:00:00.000Z",
      overdue: false,
    });
    expect(byId.get("med-morning")).toMatchObject({
      dueAt: "2026-06-10T07:00:00.000Z",
      overdue: true,
    });
    expect(block.nextDueAt).toBe("2026-06-10T07:00:00.000Z");
    expect(block.nextDueOverdue).toBe(true);
    expect(block.nextDueMedicationName).toBe("Morgenmittel");
    expect(block.nextDueMedicationId).toBe("med-morning");
  });

  it("advances past a RESOLVED slot to the next future anchor", async () => {
    medications = [
      medication({
        name: "Mittagsmittel",
        schedules: [
          dailySchedule({
            windowStart: "11:00",
            windowEnd: "12:00",
            timesOfDay: ["11:00"],
          }),
        ],
      }),
    ];
    // The 11:00-Berlin slot was acted on — taken row at the anchor.
    resolvedRows = [
      {
        medicationId: "med-1",
        scheduledFor: new Date("2026-06-10T09:00:00.000Z"),
        // Slot-anchored take (attributed): takenAt differs from the anchor.
        takenAt: new Date("2026-06-10T09:05:00.000Z"),
      },
    ];

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    // Tomorrow's 11:00 Berlin anchor.
    expect(block.nextDueAt).toBe("2026-06-11T09:00:00.000Z");
    expect(block.nextDueOverdue).toBe(false);
  });

  it("preserves equal-time medications, ordered by when each turned due", async () => {
    medications = [
      medication({
        id: "med-mounjaro",
        name: "Mounjaro",
        startsOn: new Date("2026-06-10T00:00:00.000Z"),
        schedules: [
          dailySchedule({
            id: "sched-mounjaro",
            medicationId: "med-mounjaro",
            windowStart: "11:00",
            windowEnd: "11:00",
            timesOfDay: ["11:00"],
            rrule: null,
            rollingIntervalDays: 7,
          }),
        ],
      }),
      medication({
        id: "med-ramipril",
        name: "Ramipril",
        schedules: [
          dailySchedule({
            id: "sched-ramipril",
            medicationId: "med-ramipril",
            windowStart: "11:00",
            windowEnd: "11:00",
            timesOfDay: ["11:00"],
          }),
        ],
      }),
    ];

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    expect(block.dueCandidates).toEqual([
      {
        medicationId: "med-mounjaro",
        medicationName: "Mounjaro",
        dueAt: "2026-06-10T09:00:00.000Z",
        // A rolling dose the ledger has not minted: the default weekly band.
        overdue: false,
        availableFrom: "2026-06-09T09:00:00.000Z",
        opensAt: "2026-06-10T09:00:00.000Z",
      },
      {
        medicationId: "med-ramipril",
        medicationName: "Ramipril",
        dueAt: "2026-06-10T09:00:00.000Z",
        overdue: false,
        availableFrom: "2026-06-10T08:00:00.000Z",
        opensAt: "2026-06-10T09:00:00.000Z",
      },
    ]);
    expect(block.nextDueAt).toBe("2026-06-10T09:00:00.000Z");
    expect(block.nextDueOverdue).toBe(false);
    expect(block.nextDueMedicationName).toBe("Mounjaro");
    expect(block.nextDueMedicationId).toBe("med-mounjaro");
  });

  it("names when a dose window opens, and the anchor when there is none", async () => {
    // 10:00Z is 12:00 Berlin; a 17:00 dose with a 15:00 to 22:00 window, and
    // a plain 20:00 dose.
    medications = [
      medication({
        id: "med-window",
        name: "Window",
        schedules: [
          dailySchedule({
            id: "sched-window",
            medicationId: "med-window",
            windowStart: "17:00",
            windowEnd: "18:00",
            timesOfDay: ["17:00"],
            doseWindows: [{ timeOfDay: "17:00", start: "15:00", end: "22:00" }],
          }),
        ],
      }),
      medication({
        id: "med-plain",
        name: "Plain",
        schedules: [
          dailySchedule({
            id: "sched-plain",
            medicationId: "med-plain",
            windowStart: "20:00",
            windowEnd: "21:00",
            timesOfDay: ["20:00"],
          }),
        ],
      }),
    ];
    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);
    const byId = new Map(
      (block.dueCandidates ?? []).map((c) => [c.medicationId, c]),
    );
    expect(byId.get("med-window")).toMatchObject({
      dueAt: "2026-06-10T15:00:00.000Z",
      opensAt: "2026-06-10T13:00:00.000Z",
    });
    expect(byId.get("med-plain")).toMatchObject({
      dueAt: "2026-06-10T18:00:00.000Z",
      opensAt: "2026-06-10T18:00:00.000Z",
    });
  });

  it("returns null next-due when no schedule has an upcoming slot", async () => {
    // Course ended last month — the engine yields nothing.
    medications = [
      medication({
        name: "Altmittel",
        endsOn: new Date("2026-05-01T00:00:00.000Z"),
      }),
    ];

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    expect(block.activeCount).toBe(1);
    expect(block.nextDueAt).toBeNull();
    expect(block.nextDueOverdue).toBe(false);
    expect(block.nextDueMedicationName).toBeNull();
    expect(block.nextDueMedicationId).toBeNull();
  });
});
