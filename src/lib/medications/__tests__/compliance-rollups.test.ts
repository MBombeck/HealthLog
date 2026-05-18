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
  executeRaw: vi.fn(),
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
    $executeRaw: mocks.executeRaw,
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
  enqueueUserMedicationComplianceBackfill,
  MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
} from "../compliance-rollups";

const {
  intakeFindMany,
  rollupUpsert,
  rollupDeleteMany,
  rollupFindMany,
  rollupFindFirst,
  queryRaw,
  executeRaw,
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
  executeRaw.mockResolvedValue(0);
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
  /**
   * Helper: pull the bind-variable values out of a Prisma tagged-template
   * call so the test can inspect the user-id / day / window bounds the
   * SQL was rendered with. Prisma's `$executeRaw` tag passes the
   * template strings as the first arg and the substituted values as the
   * remaining positional args.
   */
  function bindValues(call: unknown[]): unknown[] {
    return call.slice(1);
  }

  it("runs an atomic INSERT … ON CONFLICT upsert with the (user, medication, day) tuple", async () => {
    // QA F-H-02 (v1.4.39): the recompute is now a single SQL statement
    // that re-aggregates inside the upsert; the JS pre-fold from the
    // previous tier is gone so the test inspects the bind values
    // instead of the intake fold.
    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );

    // Two statements fire: the INSERT … ON CONFLICT upsert and the
    // companion DELETE for the "all events removed" branch.
    expect(executeRaw).toHaveBeenCalledTimes(2);
    const insertBinds = bindValues(executeRaw.mock.calls[0]);
    expect(insertBinds).toContain("user-1");
    expect(insertBinds).toContain("med-1");
    expect(insertBinds).toContain("2026-05-18");
    const deleteBinds = bindValues(executeRaw.mock.calls[1]);
    expect(deleteBinds).toContain("user-1");
    expect(deleteBinds).toContain("med-1");
    expect(deleteBinds).toContain("2026-05-18");
  });

  it("emits a paired DELETE so a fully-cleared day removes its row", async () => {
    // The DELETE fires unconditionally and gates on NOT EXISTS — when
    // the day still has events the predicate matches zero rows. The
    // test pins that the DELETE statement was issued so a future
    // refactor that drops the second statement breaks here.
    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );

    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it("is idempotent across repeated invocations", async () => {
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

    expect(executeRaw).toHaveBeenCalledTimes(4);
    expect(bindValues(executeRaw.mock.calls[0])).toEqual(
      bindValues(executeRaw.mock.calls[2]),
    );
    expect(bindValues(executeRaw.mock.calls[1])).toEqual(
      bindValues(executeRaw.mock.calls[3]),
    );
  });

  it("binds a tz-anchored UTC window into the upsert", async () => {
    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );

    const insertBinds = bindValues(executeRaw.mock.calls[0]);
    const insertDates = insertBinds.filter((b): b is Date => b instanceof Date);
    // Berlin 2026-05-18 00:00 → UTC 2026-05-17 22:00 (CEST is UTC+2).
    expect(insertDates[0].toISOString()).toBe("2026-05-17T22:00:00.000Z");
    // Window closes 24h later — Berlin 2026-05-19 00:00 → UTC 2026-05-18 22:00.
    expect(insertDates[1].toISOString()).toBe("2026-05-18T22:00:00.000Z");
  });

  it("buckets the same UTC instant on different days for Berlin vs LA", async () => {
    await recomputeMedicationComplianceForDay(
      "user-1",
      "med-1",
      "2026-05-18",
      "Europe/Berlin",
    );
    const berlinInsert = bindValues(executeRaw.mock.calls[0]).filter(
      (b): b is Date => b instanceof Date,
    );

    executeRaw.mockClear();

    await recomputeMedicationComplianceForDay(
      "user-2",
      "med-2",
      "2026-05-17",
      "America/Los_Angeles",
    );
    const laInsert = bindValues(executeRaw.mock.calls[0]).filter(
      (b): b is Date => b instanceof Date,
    );

    // Berlin 2026-05-18 starts at UTC 2026-05-17 22:00.
    expect(berlinInsert[0].toISOString()).toBe("2026-05-17T22:00:00.000Z");
    // LA 2026-05-17 starts at UTC 2026-05-17 07:00 (PDT is UTC-7).
    expect(laInsert[0].toISOString()).toBe("2026-05-17T07:00:00.000Z");
  });

  it("commits the strictest aggregate under concurrent recompute calls", async () => {
    // QA F-H-02 race pin: two concurrent recomputes for the same
    // (user, medication, day) must both go through the atomic SQL
    // path. The earlier `findMany`-then-`upsert` pattern could
    // interleave A-SELECT → B-SELECT → B-UPSERT (correct) → A-UPSERT
    // (stale N-1); the atomic upsert serialises on the row lock so
    // each statement re-aggregates a snapshot taken after the prior
    // commit. The mock can't reproduce real Postgres concurrency, but
    // the test pins that BOTH callers issue the atomic statement (not
    // the legacy read-aggregate-then-upsert) so a regression to the
    // racy pattern would fail this assertion.
    await Promise.all([
      recomputeMedicationComplianceForDay(
        "user-1",
        "med-1",
        "2026-05-18",
        "Europe/Berlin",
      ),
      recomputeMedicationComplianceForDay(
        "user-1",
        "med-1",
        "2026-05-18",
        "Europe/Berlin",
      ),
    ]);
    // 2 callers × 2 statements (INSERT + DELETE) each.
    expect(executeRaw).toHaveBeenCalledTimes(4);
    // No legacy intake-findMany was issued — the atomic path replaces it.
    expect(intakeFindMany).not.toHaveBeenCalled();
    // No legacy rollupUpsert / rollupDeleteMany either.
    expect(rollupUpsert).not.toHaveBeenCalled();
    expect(rollupDeleteMany).not.toHaveBeenCalled();
  });
});

describe("recomputeMedicationComplianceForEvent", () => {
  it("derives the dayKey from scheduledFor + tz then dispatches", async () => {
    // 2026-05-17T23:30:00Z → Berlin day 2026-05-18.
    await recomputeMedicationComplianceForEvent({
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: new Date("2026-05-17T23:30:00.000Z"),
      tz: "Europe/Berlin",
    });
    // The atomic upsert binds the dayKey as one of the positional
    // arguments; assert "2026-05-18" reached the SQL layer.
    const insertBinds = executeRaw.mock.calls[0].slice(1);
    expect(insertBinds).toContain("2026-05-18");
  });

  it("swallows recompute errors so the parent write never blocks", async () => {
    executeRaw.mockRejectedValueOnce(new Error("DB melted"));

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

    const result = await recomputeUserMedicationCompliance(
      "user-1",
      30,
      "Europe/Berlin",
    );

    expect(result.rowsUpserted).toBe(3);
    // Each (medication, day) pair issues two atomic SQL statements:
    // the INSERT … ON CONFLICT upsert and the companion DELETE that
    // gates on `NOT EXISTS`.
    expect(executeRaw).toHaveBeenCalledTimes(6);
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

describe("enqueueUserMedicationComplianceBackfill", () => {
  it("is a no-op when no boss is attached", async () => {
    getGlobalBossMock.mockReturnValue(null);
    const result = await enqueueUserMedicationComplianceBackfill("user-1");
    expect(result).toEqual({ enqueued: false, error: null });
    // Critically: no `$queryRaw` cluster-wide LEFT JOIN scan.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("enqueues exactly one job for the caller's user and never touches the cluster-wide LEFT JOIN", async () => {
    // QA F-SEC-M-01 (v1.4.39): pre-fix the request-path coverage-miss
    // path called `enqueueBootTimeMedicationComplianceBackfill` which
    // issued a cluster-wide `LEFT JOIN medication_intake_events ×
    // medication_compliance_rollups` on every hit. The user-scoped
    // helper sends one targeted job and never runs the discovery scan.
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValueOnce("job-1");
    const result = await enqueueUserMedicationComplianceBackfill("user-1");
    expect(result).toEqual({ enqueued: true, error: null });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith(
      MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
      expect.objectContaining({ userId: "user-1" }),
      expect.objectContaining({
        singletonKey: "medication-compliance-boot-backfill|user-1",
      }),
    );
  });

  it("reports a coalesced enqueue as `enqueued:false`", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValueOnce(null);
    const result = await enqueueUserMedicationComplianceBackfill("user-2");
    expect(result).toEqual({ enqueued: false, error: null });
  });
});
