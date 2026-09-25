/**
 * v1.4.46 — coverage for the hourly intake-auto-miss helper.
 *
 * v1.15.9 — the terminal state is `auto_missed = true`, NOT `skipped =
 * true`. A forgotten dose is a real MISS that must count against adherence;
 * flipping `skipped` (which the compliance engine excludes from the
 * denominator) silently inflated the rate.
 *
 * v1.15.20 — the cutoff is cadence-aware and the flip is tombstone-safe.
 * These tests pin:
 *   * cron + queue contract (constants don't drift),
 *   * the 24 h floor for minute-scale cadences (off-by-one safety at the
 *     boundary, strict `<`),
 *   * the day-scale (weekly / rolling) delay — a pending injectable slot
 *     inside its band tail (on-time + overdue reach) is NOT flipped, one
 *     past the tail IS,
 *   * configured `doseWindows` on a daily cadence extend the delay past
 *     the floor,
 *   * tombstoned rows (`deletedAt`) are never flipped,
 *   * the update stamps `auto_missed = true` + a `syncVersion` increment,
 *   * a user-skipped row is left untouched (a deliberate pause is never
 *     reclassified as a miss),
 *   * idempotency-by-construction (a second pass finds zero candidates).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

import { caches, __resetAllCachesForTests } from "@/lib/cache/server-cache";
import {
  INTAKE_AUTO_SKIP_CRON,
  INTAKE_AUTO_SKIP_GRACE_HOURS,
  INTAKE_AUTO_SKIP_QUEUE,
  medicationAutoMissDelayMs,
  runIntakeAutoSkipPass,
} from "../intake-auto-skip";

interface FakeIntakeRow {
  id: string;
  userId: string;
  medicationId: string;
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  autoMissed: boolean;
  deletedAt: Date | null;
  syncVersion: number;
}

interface FakeScheduleRow {
  rrule: string | null;
  rollingIntervalDays: number | null;
  doseWindows: unknown;
}

interface FakeMedication {
  id: string;
  /** Defaults to long before every fixture row when omitted. */
  createdAt?: Date;
  schedules: FakeScheduleRow[];
}

interface FakeWhere {
  skipped?: boolean;
  autoMissed?: boolean;
  takenAt?: null;
  deletedAt?: null;
  medicationId?: string | { in: string[] };
  scheduledFor?: { lt?: Date; gte?: Date };
  OR?: FakeWhere[];
}

function matches(row: FakeIntakeRow, where: FakeWhere): boolean {
  if (where.skipped !== undefined && row.skipped !== where.skipped)
    return false;
  if (where.autoMissed !== undefined && row.autoMissed !== where.autoMissed)
    return false;
  if (where.takenAt === null && row.takenAt !== null) return false;
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (
    typeof where.medicationId === "string" &&
    row.medicationId !== where.medicationId
  )
    return false;
  if (
    typeof where.medicationId === "object" &&
    !where.medicationId.in.includes(row.medicationId)
  )
    return false;
  if (
    where.scheduledFor?.gte !== undefined &&
    row.scheduledFor.getTime() < where.scheduledFor.gte.getTime()
  )
    return false;
  if (where.OR !== undefined && !where.OR.some((w) => matches(row, w)))
    return false;
  if (
    where.scheduledFor?.lt !== undefined &&
    row.scheduledFor.getTime() >= where.scheduledFor.lt.getTime()
  )
    return false;
  return true;
}

function makeFakePrisma(state: {
  rows: FakeIntakeRow[];
  medications: FakeMedication[];
}) {
  return {
    medicationIntakeEvent: {
      groupBy: vi.fn(async ({ where }: { where: FakeWhere }) => {
        // Mirrors `by: ["medicationId", "userId"]` — unique pairs.
        const pairs = new Map<
          string,
          { medicationId: string; userId: string }
        >();
        for (const row of state.rows) {
          if (!matches(row, where)) continue;
          pairs.set(`${row.medicationId}|${row.userId}`, {
            medicationId: row.medicationId,
            userId: row.userId,
          });
        }
        return [...pairs.values()];
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: FakeWhere;
          data: { autoMissed: boolean; syncVersion: { increment: number } };
        }) => {
          let count = 0;
          for (const row of state.rows) {
            if (!matches(row, where)) continue;
            row.autoMissed = data.autoMissed;
            row.syncVersion += data.syncVersion.increment;
            count += 1;
          }
          return { count };
        },
      ),
    },
    medication: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        state.medications
          .filter((m) => where.id.in.includes(m.id))
          .map((m) => ({
            createdAt: new Date("2020-01-01T00:00:00Z"),
            ...m,
          })),
      ),
    },
  } as unknown as PrismaClient;
}

const NOW = new Date("2026-05-22T12:00:00Z");
const NOW_MS = NOW.getTime();
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DAILY_MED: FakeMedication = {
  id: "med-daily",
  schedules: [
    { rrule: "FREQ=DAILY", rollingIntervalDays: null, doseWindows: null },
  ],
};
const WEEKLY_MED: FakeMedication = {
  id: "med-weekly",
  schedules: [
    {
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      rollingIntervalDays: null,
      doseWindows: null,
    },
  ],
};
const ROLLING_MED: FakeMedication = {
  id: "med-rolling",
  schedules: [{ rrule: null, rollingIntervalDays: 7, doseWindows: null }],
};
const WINDOWED_DAILY_MED: FakeMedication = {
  id: "med-windowed",
  schedules: [
    {
      rrule: "FREQ=DAILY",
      rollingIntervalDays: null,
      doseWindows: [{ timeOfDay: "08:00", start: "07:00", end: "10:00" }],
    },
  ],
};

function pendingRow(
  id: string,
  medicationId: string,
  scheduledFor: Date,
  overrides: Partial<FakeIntakeRow> = {},
): FakeIntakeRow {
  return {
    id,
    userId: "u1",
    medicationId,
    scheduledFor,
    takenAt: null,
    skipped: false,
    autoMissed: false,
    deletedAt: null,
    syncVersion: 0,
    ...overrides,
  };
}

describe("intake-auto-skip — schedule contract", () => {
  it("cron fires hourly at :05 to dodge the :00 reminder-check tick", () => {
    expect(INTAKE_AUTO_SKIP_CRON).toBe("5 * * * *");
  });

  it("queue name stays stable so the scheduler entry doesn't desync", () => {
    expect(INTAKE_AUTO_SKIP_QUEUE).toBe("intake-auto-skip");
  });

  it("grace floor is exactly 24 hours", () => {
    expect(INTAKE_AUTO_SKIP_GRACE_HOURS).toBe(24);
  });
});

describe("medicationAutoMissDelayMs", () => {
  it("keeps the 24 h floor for a default daily cadence", () => {
    expect(medicationAutoMissDelayMs(DAILY_MED.schedules)).toBe(24 * HOUR_MS);
  });

  it("derives the day-scale band reach for a weekly rrule (5 d + DST pad)", () => {
    expect(medicationAutoMissDelayMs(WEEKLY_MED.schedules)).toBe(
      5 * DAY_MS + HOUR_MS,
    );
  });

  it("derives the day-scale band reach for a rolling cadence", () => {
    expect(medicationAutoMissDelayMs(ROLLING_MED.schedules)).toBe(
      5 * DAY_MS + HOUR_MS,
    );
  });

  it("treats a ≤1-day rolling interval as minute-scale (24 h floor)", () => {
    expect(
      medicationAutoMissDelayMs([
        { rrule: null, rollingIntervalDays: 1, doseWindows: null },
      ]),
    ).toBe(24 * HOUR_MS);
  });

  it("extends a daily cadence with configured doseWindows past the floor", () => {
    // A configured window end can sit up to a local day past the slot
    // anchor: a day + the default overdue tail + the DST pad.
    expect(medicationAutoMissDelayMs(WINDOWED_DAILY_MED.schedules)).toBe(
      DAY_MS + 180 * 60 * 1000 + HOUR_MS,
    );
  });

  it("a mixed-cadence medication waits for its widest schedule", () => {
    expect(
      medicationAutoMissDelayMs([
        ...DAILY_MED.schedules,
        ...WEEKLY_MED.schedules,
      ]),
    ).toBe(5 * DAY_MS + HOUR_MS);
  });
});

describe("runIntakeAutoSkipPass", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    __resetAllCachesForTests();
  });

  it("flips daily pending rows older than 24 h to auto_missed (NOT skipped)", async () => {
    const rows: FakeIntakeRow[] = [
      pendingRow("i-stale-1", "med-daily", new Date(NOW_MS - 30 * HOUR_MS)),
      pendingRow("i-stale-2", "med-daily", new Date(NOW_MS - 48 * HOUR_MS), {
        userId: "u2",
      }),
      pendingRow("i-recent", "med-daily", new Date(NOW_MS - 6 * HOUR_MS)),
      pendingRow("i-taken", "med-daily", new Date(NOW_MS - 36 * HOUR_MS), {
        takenAt: new Date(NOW_MS - 30 * HOUR_MS),
      }),
      pendingRow(
        "i-already-skipped",
        "med-daily",
        new Date(NOW_MS - 48 * HOUR_MS),
        { skipped: true },
      ),
    ];
    const state = { rows, medications: [DAILY_MED] };
    const prisma = makeFakePrisma(state);

    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });

    expect(result.skippedCount).toBe(2);
    expect(result.cutoff.getTime()).toBe(NOW_MS - DAY_MS);
    expect(rows.find((r) => r.id === "i-stale-1")?.autoMissed).toBe(true);
    expect(rows.find((r) => r.id === "i-stale-2")?.autoMissed).toBe(true);
    expect(rows.find((r) => r.id === "i-recent")?.autoMissed).toBe(false);
    expect(rows.find((r) => r.id === "i-taken")?.autoMissed).toBe(false);
    // The forgotten doses are NOT marked as a user skip.
    expect(rows.find((r) => r.id === "i-stale-1")?.skipped).toBe(false);
    // A deliberate user skip is left exactly as it was.
    expect(rows.find((r) => r.id === "i-already-skipped")?.skipped).toBe(true);
    expect(rows.find((r) => r.id === "i-already-skipped")?.autoMissed).toBe(
      false,
    );
  });

  it("invalidates the affected users' server caches after a flip (v1.16.1)", async () => {
    const rows: FakeIntakeRow[] = [
      pendingRow("i-u1", "med-daily", new Date(NOW_MS - 30 * HOUR_MS)),
      pendingRow("i-u2", "med-daily", new Date(NOW_MS - 48 * HOUR_MS), {
        userId: "u2",
      }),
    ];
    const prisma = makeFakePrisma({ rows, medications: [DAILY_MED] });
    // Warm a compliance cache entry for an affected and an unaffected user.
    caches.medicationCompliance.set("u1|med-daily|compliance|UTC", { x: 1 });
    caches.medicationCompliance.set("u3|med-x|compliance|UTC", { x: 2 });

    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });

    expect([...result.invalidatedUserIds].sort()).toEqual(["u1", "u2"]);
    // The flipped users' cached compliance payloads dropped; the
    // untouched user's entry survives.
    expect(
      caches.medicationCompliance.get("u1|med-daily|compliance|UTC"),
    ).toBeNull();
    expect(
      caches.medicationCompliance.get("u3|med-x|compliance|UTC"),
    ).not.toBeNull();
  });

  it("reports no invalidated users when nothing flipped", async () => {
    const rows = [
      pendingRow("i-fresh", "med-daily", new Date(NOW_MS - 6 * HOUR_MS)),
    ];
    const prisma = makeFakePrisma({ rows, medications: [DAILY_MED] });
    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.invalidatedUserIds).toEqual([]);
  });

  it("bumps syncVersion on every flipped row", async () => {
    const rows = [
      pendingRow("i-sync", "med-daily", new Date(NOW_MS - 30 * HOUR_MS)),
    ];
    const prisma = makeFakePrisma({ rows, medications: [DAILY_MED] });
    await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(rows[0].syncVersion).toBe(1);
  });

  it("never flips a tombstoned row", async () => {
    const rows = [
      pendingRow("i-tombstoned", "med-daily", new Date(NOW_MS - 72 * HOUR_MS), {
        deletedAt: new Date(NOW_MS - 50 * HOUR_MS),
      }),
    ];
    const prisma = makeFakePrisma({ rows, medications: [DAILY_MED] });
    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(0);
    expect(rows[0].autoMissed).toBe(false);
  });

  it("leaves a weekly slot inside its band tail pending (no 24 h stamp)", async () => {
    // 3 days past the anchor: past the legacy 24 h grace but inside the
    // day-scale on-time + overdue reach (5 days) — the ledger still shows
    // the dose takeable, so the cron must not contradict it.
    const rows = [
      pendingRow("i-weekly-tail", "med-weekly", new Date(NOW_MS - 3 * DAY_MS)),
    ];
    const prisma = makeFakePrisma({ rows, medications: [WEEKLY_MED] });
    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(0);
    expect(rows[0].autoMissed).toBe(false);
  });

  it("flips a weekly slot once its band tail has fully passed", async () => {
    const rows = [
      pendingRow("i-weekly-gone", "med-weekly", new Date(NOW_MS - 6 * DAY_MS)),
    ];
    const prisma = makeFakePrisma({ rows, medications: [WEEKLY_MED] });
    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(1);
    expect(rows[0].autoMissed).toBe(true);
  });

  it("applies per-medication cutoffs independently in one pass", async () => {
    const rows = [
      pendingRow("i-daily-old", "med-daily", new Date(NOW_MS - 30 * HOUR_MS)),
      pendingRow(
        "i-rolling-tail",
        "med-rolling",
        new Date(NOW_MS - 3 * DAY_MS),
      ),
      pendingRow(
        "i-rolling-gone",
        "med-rolling",
        new Date(NOW_MS - 8 * DAY_MS),
      ),
    ];
    const prisma = makeFakePrisma({
      rows,
      medications: [DAILY_MED, ROLLING_MED],
    });
    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(2);
    expect(rows.find((r) => r.id === "i-daily-old")?.autoMissed).toBe(true);
    expect(rows.find((r) => r.id === "i-rolling-tail")?.autoMissed).toBe(false);
    expect(rows.find((r) => r.id === "i-rolling-gone")?.autoMissed).toBe(true);
  });

  it("issues zero writes when no candidate rows exist", async () => {
    const prisma = makeFakePrisma({ rows: [], medications: [DAILY_MED] });
    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(0);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.updateMany).not.toHaveBeenCalled();
  });

  it("groups medications with the same delay into one updateMany", async () => {
    const rows = [
      pendingRow("i-w1", "med-weekly", new Date(NOW_MS - 6 * DAY_MS)),
      pendingRow("i-w2", "med-rolling", new Date(NOW_MS - 6 * DAY_MS)),
    ];
    const prisma = makeFakePrisma({
      rows,
      medications: [WEEKLY_MED, ROLLING_MED],
    });
    await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    // Both medications derive the identical day-scale delay → one batch.
    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second pass on the same state finds zero candidates", async () => {
    const rows = [
      pendingRow("i-stale", "med-daily", new Date(NOW_MS - 30 * HOUR_MS)),
    ];
    const prisma = makeFakePrisma({ rows, medications: [DAILY_MED] });

    const first = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(first.skippedCount).toBe(1);

    const second = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(second.skippedCount).toBe(0);
  });

  it("does NOT flip rows exactly at the 24 h boundary (uses strict <)", async () => {
    // The SQL gate is `scheduledFor < NOW - delay` — a row whose
    // `scheduledFor` lands at the cutoff instant must stay pending so
    // the user still has the closing minute of the window to mark it.
    const rows = [
      pendingRow("i-boundary", "med-daily", new Date(NOW_MS - DAY_MS)),
    ];
    const prisma = makeFakePrisma({ rows, medications: [DAILY_MED] });

    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(result.skippedCount).toBe(0);
    expect(rows[0].autoMissed).toBe(false);
  });

  // #1028 — the today projector mints a pending placeholder for every slot
  // of the day, including the slots before the medication was added. Such a
  // slot was never expected, so its placeholder must never become a miss:
  // the miss-free streak, the Coach and every other raw-row reader would
  // count it.
  it("never flips a placeholder whose slot predates the medication", async () => {
    const createdAt = new Date(NOW_MS - 30 * HOUR_MS);
    const rows = [
      pendingRow("i-before", "med-new", new Date(NOW_MS - 37 * HOUR_MS)),
      pendingRow("i-after", "med-new", new Date(NOW_MS - 25 * HOUR_MS)),
      pendingRow("i-old-med", "med-daily", new Date(NOW_MS - 37 * HOUR_MS)),
    ];
    const prisma = makeFakePrisma({
      rows,
      medications: [{ ...DAILY_MED, id: "med-new", createdAt }, DAILY_MED],
    });
    const result = await runIntakeAutoSkipPass(prisma, { nowMs: NOW_MS });
    expect(rows.find((r) => r.id === "i-before")?.autoMissed).toBe(false);
    expect(rows.find((r) => r.id === "i-after")?.autoMissed).toBe(true);
    expect(rows.find((r) => r.id === "i-old-med")?.autoMissed).toBe(true);
    expect(result.skippedCount).toBe(2);
  });

  it("uses Date.now() when no nowMs override is supplied", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const prisma = makeFakePrisma({ rows: [], medications: [] });
      const result = await runIntakeAutoSkipPass(prisma);
      expect(result.cutoff.getTime()).toBe(NOW_MS - DAY_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});
