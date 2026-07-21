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
 *   - the next-due pick is the EARLIEST display-due across active
 *     medications (real recurrence engine, no engine mocks);
 *   - an open overdue slot surfaces with `nextDueOverdue: true` and a
 *     resolved slot at the same anchor advances to the next future one;
 *   - the today window is computed in the USER's timezone (asserted on
 *     the where-clause bounds for a non-European zone).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const projectTodayIntakesAndRecompute = vi.fn();

vi.mock("@/lib/medications/scheduling/project-today-intakes", () => ({
  projectTodayIntakesAndRecompute: (...a: unknown[]) =>
    projectTodayIntakesAndRecompute(...a),
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
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    schedules: [dailySchedule()],
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
let latestIntakeGroups: Array<{
  medicationId: string;
  _max: { takenAt: Date | null };
}>;
let eraFloorGroups: Array<{
  medicationId: string;
  _max: { validUntil: Date | null };
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
    findMany: vi.fn(
      async (args: { where: { OR?: unknown; scheduledFor?: unknown } }) => {
        if (args.where.OR) {
          callOrder.push("resolved.findMany");
          return resolvedRows;
        }
        callOrder.push("today.findMany");
        capturedTodayWhere = args.where as Record<string, unknown>;
        return todayRows;
      },
    ),
    groupBy: vi.fn(async () => {
      callOrder.push("latest.groupBy");
      return latestIntakeGroups;
    }),
  },
  medicationScheduleRevision: {
    groupBy: vi.fn(async () => {
      callOrder.push("era.groupBy");
      return eraFloorGroups;
    }),
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
  medications = [];
  todayRows = [];
  resolvedRows = [];
  latestIntakeGroups = [];
  eraFloorGroups = [];
  capturedTodayWhere = null;
  projectTodayIntakesAndRecompute.mockImplementation(async () => {
    callOrder.push("project");
    return { projected: 0, backfilled: 0 };
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

describe("buildMedsTodayBlock — tally", () => {
  it("counts scheduled / taken / skipped with the summary-tile semantics", async () => {
    todayRows = [
      { takenAt: new Date("2026-06-10T06:05:00.000Z"), skipped: false },
      { takenAt: new Date("2026-06-10T08:00:00.000Z"), skipped: false },
      { takenAt: null, skipped: true }, // deliberate skip
      { takenAt: null, skipped: false }, // still-open pending
    ];

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    expect(block.scheduledToday).toBe(4);
    expect(block.takenToday).toBe(2);
    expect(block.skippedToday).toBe(1);
  });

  it("returns a zeroed block for an account with no medications", async () => {
    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);
    expect(block).toEqual({
      activeCount: 0,
      scheduledToday: 0,
      takenToday: 0,
      skippedToday: 0,
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
    expect(arg.where).toEqual({ userId: "user-1", active: true });
  });
});

describe("buildMedsTodayBlock — next due (real engine)", () => {
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

  it("surfaces an open overdue slot (anchor passed, band still open)", async () => {
    // 11:00 Berlin anchor = 09:00Z; now is 12:00 Berlin — one hour past
    // the anchor, well inside the daily 4 h catch-up band.
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

    const block = await buildMedsTodayBlock(fakePrisma, "user-1", BERLIN, NOW);

    expect(block.nextDueAt).toBe("2026-06-10T09:00:00.000Z");
    expect(block.nextDueOverdue).toBe(true);
    expect(block.nextDueMedicationName).toBe("Mittagsmittel");
    expect(block.nextDueMedicationId).toBe("med-1");
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

  it("preserves equal-time medications and orders the overdue candidate first", async () => {
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
        medicationId: "med-ramipril",
        medicationName: "Ramipril",
        dueAt: "2026-06-10T09:00:00.000Z",
        overdue: true,
        availableFrom: "2026-06-10T07:00:00.000Z",
      },
      {
        medicationId: "med-mounjaro",
        medicationName: "Mounjaro",
        dueAt: "2026-06-10T09:00:00.000Z",
        overdue: false,
        availableFrom: "2026-06-09T08:00:00.000Z",
      },
    ]);
    expect(block.nextDueAt).toBe("2026-06-10T09:00:00.000Z");
    expect(block.nextDueOverdue).toBe(true);
    expect(block.nextDueMedicationName).toBe("Ramipril");
    expect(block.nextDueMedicationId).toBe("med-ramipril");
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
