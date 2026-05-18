/**
 * v1.4.39 W-MED — unit tests for the medication-compliance rollup tier.
 *
 * `prisma` is mocked at the module boundary so the test can pin the
 * intake-event fan-out + the rollup upsert / read shape without
 * standing up a real Postgres. Integration coverage (real Postgres +
 * the FK cascade behaviour) lives next to the route test suite when
 * the W-MED phase grows them; this file proves the helpers'
 * contract.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  intakeFindMany: vi.fn(),
  rollupUpsert: vi.fn(),
  rollupDeleteMany: vi.fn(),
  rollupFindMany: vi.fn(),
  rollupFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  bossSend: vi.fn(),
  getGlobalBossMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationIntakeEvent: {
      findMany: mocks.intakeFindMany,
    },
    medicationComplianceRollup: {
      upsert: mocks.rollupUpsert,
      deleteMany: mocks.rollupDeleteMany,
      findMany: mocks.rollupFindMany,
      findFirst: mocks.rollupFindFirst,
    },
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => mocks.getGlobalBossMock(),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
  recomputeMedicationComplianceForEvent,
  readMedicationCompliance,
  hasMedicationComplianceCoverage,
  recomputeUserMedicationCompliance,
  enqueueBootTimeMedicationComplianceBackfill,
  MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
} from "../compliance-rollups";

const {
  intakeFindMany,
  rollupUpsert,
  rollupDeleteMany,
  rollupFindMany,
  rollupFindFirst,
  queryRaw,
  bossSend,
  getGlobalBossMock,
} = mocks;

beforeEach(() => {
  vi.resetAllMocks();
  intakeFindMany.mockResolvedValue([]);
  rollupUpsert.mockResolvedValue({});
  rollupDeleteMany.mockResolvedValue({ count: 0 });
  rollupFindMany.mockResolvedValue([]);
  rollupFindFirst.mockResolvedValue(null);
  queryRaw.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dayKeyForScheduledFor", () => {
  it("anchors the dayKey on the user's tz wall clock", () => {
    // 2026-05-17T23:30:00Z — Berlin local is 2026-05-18 01:30 (CEST).
    const ts = new Date("2026-05-17T23:30:00.000Z");
    expect(dayKeyForScheduledFor(ts, "Europe/Berlin")).toBe("2026-05-18");
    // Los Angeles is UTC-7 (PDT) — still 2026-05-17 16:30 local.
    expect(dayKeyForScheduledFor(ts, "America/Los_Angeles")).toBe("2026-05-17");
  });

  it("falls back to the server default when tz is null", () => {
    const ts = new Date("2026-05-17T22:00:00.000Z");
    expect(dayKeyForScheduledFor(ts, null)).toBe(
      dayKeyForScheduledFor(ts, "Europe/Berlin"),
    );
  });
});

describe("recomputeMedicationComplianceForDay", () => {
  it("upserts a row reflecting the (scheduled, taken, skipped) counts", async () => {
    intakeFindMany.mockResolvedValue([
      { takenAt: new Date(), skipped: false }, // taken
      { takenAt: null, skipped: true }, // skipped
      { takenAt: null, skipped: false }, // pending
    ]);

    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );

    expect(rollupUpsert).toHaveBeenCalledTimes(1);
    const call = rollupUpsert.mock.calls[0][0];
    expect(call.where).toEqual({
      userId_medicationId_day: {
        userId: "user-1",
        medicationId: "med-1",
        day: "2026-05-18",
      },
    });
    expect(call.create).toMatchObject({
      userId: "user-1",
      medicationId: "med-1",
      day: "2026-05-18",
      scheduled: 3,
      taken: 1,
      skipped: 1,
    });
    expect(call.update).toMatchObject({
      scheduled: 3,
      taken: 1,
      skipped: 1,
    });
  });

  it("deletes the rollup row when the user-day window holds zero events", async () => {
    intakeFindMany.mockResolvedValue([]);

    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );

    expect(rollupDeleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", medicationId: "med-1", day: "2026-05-18" },
    });
    expect(rollupUpsert).not.toHaveBeenCalled();
  });

  it("is idempotent across repeated invocations", async () => {
    intakeFindMany.mockResolvedValue([
      { takenAt: new Date(), skipped: false },
    ]);

    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );
    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );

    expect(rollupUpsert).toHaveBeenCalledTimes(2);
    const first = rollupUpsert.mock.calls[0][0].create;
    const second = rollupUpsert.mock.calls[1][0].create;
    expect(first).toEqual(second);
  });

  it("queries with a tz-anchored UTC window", async () => {
    intakeFindMany.mockResolvedValue([
      { takenAt: new Date(), skipped: false },
    ]);

    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );

    const where = intakeFindMany.mock.calls[0][0].where;
    // Berlin 2026-05-18 00:00 → UTC 2026-05-17 22:00 (CEST is UTC+2).
    expect(where.scheduledFor.gte.toISOString()).toBe(
      "2026-05-17T22:00:00.000Z",
    );
    // Window closes 24h later — Berlin 2026-05-19 00:00 → UTC 2026-05-18 22:00.
    expect(where.scheduledFor.lt.toISOString()).toBe(
      "2026-05-18T22:00:00.000Z",
    );
  });

  it("buckets the same UTC instant on different days for Berlin vs LA", async () => {
    // 2026-05-17T23:30:00Z is 2026-05-18 in Berlin but 2026-05-17 in LA.
    intakeFindMany.mockResolvedValue([
      { takenAt: new Date(), skipped: false },
    ]);

    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );
    const berlinCall = intakeFindMany.mock.calls[0][0].where;

    intakeFindMany.mockClear();
    rollupUpsert.mockClear();

    await recomputeMedicationComplianceForDay(
      "user-2",
      "med-2",
      "2026-05-17",
      "America/Los_Angeles",
    );
    const laCall = intakeFindMany.mock.calls[0][0].where;

    // Berlin 2026-05-18 starts at UTC 2026-05-17 22:00.
    expect(berlinCall.scheduledFor.gte.toISOString()).toBe(
      "2026-05-17T22:00:00.000Z",
    );
    // LA 2026-05-17 starts at UTC 2026-05-17 07:00 (PDT is UTC-7).
    expect(laCall.scheduledFor.gte.toISOString()).toBe(
      "2026-05-17T07:00:00.000Z",
    );
  });
});

describe("recomputeMedicationComplianceForEvent", () => {
  it("derives the dayKey from scheduledFor + tz then dispatches", async () => {
    intakeFindMany.mockResolvedValue([
      { takenAt: new Date(), skipped: false },
    ]);
    // 2026-05-17T23:30:00Z → Berlin day 2026-05-18.
    await recomputeMedicationComplianceForEvent({
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: new Date("2026-05-17T23:30:00.000Z"),
      tz: "Europe/Berlin",
    });
    const call = rollupUpsert.mock.calls[0][0];
    expect(call.create.day).toBe("2026-05-18");
  });

  it("swallows recompute errors so the parent write never blocks", async () => {
    intakeFindMany.mockRejectedValue(new Error("DB melted"));

    await expect(
      recomputeMedicationComplianceForEvent({
        userId: "user-1",
        medicationId: "med-1",
        scheduledFor: new Date("2026-05-17T12:00:00.000Z"),
        tz: "Europe/Berlin",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("readMedicationCompliance", () => {
  it("returns a trailing-window zero-filled bucket array", async () => {
    rollupFindMany.mockResolvedValue([
      { day: "2026-05-18", scheduled: 2, taken: 1, skipped: 1 },
    ]);

    const now = new Date("2026-05-18T12:00:00.000Z");
    const buckets = await readMedicationCompliance(
      "user-1",
      3,
      "Europe/Berlin",
      now,
    );

    expect(buckets).toHaveLength(3);
    expect(buckets[buckets.length - 1]).toEqual({
      date: "2026-05-18",
      scheduled: 2,
      taken: 1,
    });
    expect(buckets[0].scheduled).toBe(0);
    expect(buckets[0].taken).toBe(0);
    expect(buckets.map((b) => b.date)).toEqual([
      "2026-05-16",
      "2026-05-17",
      "2026-05-18",
    ]);
  });

  it("folds per-medication rows into one per-day total", async () => {
    rollupFindMany.mockResolvedValue([
      { day: "2026-05-18", scheduled: 1, taken: 1, skipped: 0 },
      { day: "2026-05-18", scheduled: 2, taken: 0, skipped: 1 },
    ]);
    const now = new Date("2026-05-18T12:00:00.000Z");
    const buckets = await readMedicationCompliance(
      "user-1",
      1,
      "Europe/Berlin",
      now,
    );
    expect(buckets[0].scheduled).toBe(3);
    expect(buckets[0].taken).toBe(1);
  });
});

describe("hasMedicationComplianceCoverage", () => {
  it("returns true when rolled-day count meets the event-day count in window", async () => {
    queryRaw.mockResolvedValue([
      { rolled_days: BigInt(7), event_days: BigInt(7) },
    ]);
    await expect(
      hasMedicationComplianceCoverage(
        "user-1",
        7,
        "Europe/Berlin",
        new Date("2026-05-18T12:00:00.000Z"),
      ),
    ).resolves.toBe(true);
  });

  it("returns true when the user has zero events in window (trivially covered)", async () => {
    // Zero events → the read path returns a trailing-window zero-fill
    // from an empty rollup table; covered semantically.
    queryRaw.mockResolvedValue([
      { rolled_days: BigInt(0), event_days: BigInt(0) },
    ]);
    await expect(
      hasMedicationComplianceCoverage("user-1", 7, "Europe/Berlin"),
    ).resolves.toBe(true);
  });

  it("returns false on partial coverage (boot backfill mid-fold)", async () => {
    // QA F-H-01 (v1.4.39): the legacy "any row exists" probe would
    // flip true here and serve zero-filled buckets for days N..days-1
    // that the backfill hasn't reached yet. With the tightened probe
    // partial coverage forces the route into the legacy aggregator
    // until the fold completes.
    queryRaw.mockResolvedValue([
      { rolled_days: BigInt(2), event_days: BigInt(7) },
    ]);
    await expect(
      hasMedicationComplianceCoverage(
        "user-1",
        7,
        "Europe/Berlin",
        new Date("2026-05-18T12:00:00.000Z"),
      ),
    ).resolves.toBe(false);
  });

  it("returns false on zero rollups when events exist (legacy account cold start)", async () => {
    queryRaw.mockResolvedValue([
      { rolled_days: BigInt(0), event_days: BigInt(7) },
    ]);
    await expect(
      hasMedicationComplianceCoverage("user-1", 7, "Europe/Berlin"),
    ).resolves.toBe(false);
  });
});

describe("recomputeUserMedicationCompliance", () => {
  it("upserts one rollup per (medication, day) pair returned by discovery", async () => {
    queryRaw.mockResolvedValue([
      { medication_id: "med-1", day: "2026-05-17" },
      { medication_id: "med-1", day: "2026-05-18" },
      { medication_id: "med-2", day: "2026-05-18" },
    ]);
    intakeFindMany.mockResolvedValue([
      { takenAt: new Date(), skipped: false },
    ]);

    const result = await recomputeUserMedicationCompliance(
      "user-1",
      30,
      "Europe/Berlin",
    );

    expect(result.rowsUpserted).toBe(3);
    expect(rollupUpsert).toHaveBeenCalledTimes(3);
  });
});

describe("enqueueBootTimeMedicationComplianceBackfill", () => {
  it("is a no-op when no boss is attached", async () => {
    getGlobalBossMock.mockReturnValue(null);
    const result = await enqueueBootTimeMedicationComplianceBackfill();
    expect(result).toEqual({ enqueued: 0, skipped: 0, error: null });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("enqueues one job per uncovered user", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValue([{ id: "user-1" }, { id: "user-2" }]);
    bossSend.mockResolvedValueOnce("job-1");
    bossSend.mockResolvedValueOnce(null); // coalesced
    const result = await enqueueBootTimeMedicationComplianceBackfill();
    expect(result.enqueued).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.error).toBeNull();
    expect(bossSend).toHaveBeenCalledWith(
      MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({
        singletonKey: "medication-compliance-boot-backfill|user-1",
      }),
    );
  });
});
