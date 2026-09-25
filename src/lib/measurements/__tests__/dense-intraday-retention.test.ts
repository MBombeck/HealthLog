/**
 * v1.10.0 — computed scores (WX-E). Dense intra-day retention drain.
 * v1.28.31 — the fold target is HOURLY means (user-local hours).
 *
 * Pins the retention BOUND: the scan only folds per-sample dense-tier rows
 * OLDER than the retention window (`measuredAt < now - retentionDays`), so
 * the recent intra-day shape the Stress engine reads is never collapsed.
 * Also pins the dense-tier scope (HRV + PULSE + SpO2), the APPLE_HEALTH
 * source scope, the per-local-hour MEAN reduction + soft-delete, the
 * hourly `stats:` externalId shape, and the pre-fold rollup recompute.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recomputeBucketsForMeasurement } = vi.hoisted(() => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement,
}));

import {
  runDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_DAYS,
  DENSE_INTRADAY_RETENTION_TYPES,
} from "../dense-intraday-retention";
import type { PerSampleRow } from "../drain-per-sample-cumulative";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { candidateLookup, createManyVia } from "./hourly-mint-mock";

function row(
  id: string,
  value: number,
  iso: string,
  type: MeasurementType,
  unit = "ms",
  externalId: string | null = null,
): PerSampleRow {
  return { id, type, value, measuredAt: new Date(iso), externalId, unit };
}

function buildPrismaMock(
  rowsByType: Record<string, unknown[]>,
  // When set, every canonical-slot lookup inside `writeDay` resolves to
  // this existing row id — simulating a row already sitting on the target
  // externalId / anchor instant (the P2002 coexistence case).
  existingCanonicalId: string | null = null,
) {
  const create = vi.fn().mockResolvedValue({ id: "minted-hourly" });
  const update = vi.fn().mockResolvedValue({});
  const findFirst = vi
    .fn()
    .mockResolvedValue(
      existingCanonicalId ? { id: existingCanonicalId } : null,
    );
  const updateMany = vi.fn().mockResolvedValue({ count: 0 });
  const findManyMeasurement = vi.fn(
    async (args: { where: { type: string } }) =>
      rowsByType[args.where.type] ?? [],
  );
  const tx = {
    measurement: {
      create,
      update,
      findFirst,
      updateMany,
      findMany: candidateLookup(existingCanonicalId),
      createManyAndReturn: createManyVia(create),
    },
  };
  return {
    mock: {
      user: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]),
      },
      measurement: { findMany: findManyMeasurement },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb(tx),
      ),
    } as unknown as PrismaClient,
    create,
    update,
    findFirst,
    updateMany,
    findManyMeasurement,
  };
}

beforeEach(() => {
  recomputeBucketsForMeasurement.mockClear();
});

describe("runDenseIntradayRetention — retention bound", () => {
  it("only scans rows OLDER than the retention window", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await runDenseIntradayRetention(mock, { log: () => {} });

    // Every scan carries a `measuredAt < cutoff` predicate — the retention
    // boundary. Without it, in-window intra-day samples would be folded and
    // the Stress engine would lose its shape.
    for (const call of findManyMeasurement.mock.calls) {
      const where = (
        call[0] as unknown as { where: { measuredAt?: { lt: Date } } }
      ).where;
      expect(where.measuredAt?.lt).toBeInstanceOf(Date);
    }
    // The cutoff is ~DENSE_INTRADAY_RETENTION_DAYS in the past.
    const firstCutoff = (
      findManyMeasurement.mock.calls[0]?.[0] as unknown as {
        where: { measuredAt: { lt: Date } };
      }
    ).where.measuredAt.lt.getTime();
    const expected =
      Date.now() - DENSE_INTRADAY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    // Within a generous 60s of the expected boundary.
    expect(Math.abs(firstCutoff - expected)).toBeLessThan(60_000);
  });

  it("folds everything when retentionDays = 0 (no window)", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await runDenseIntradayRetention(mock, { retentionDays: 0, log: () => {} });
    for (const call of findManyMeasurement.mock.calls) {
      const where = (
        call[0] as unknown as { where: { measuredAt?: { lt: Date } } }
      ).where;
      // No cutoff predicate → the whole history is in scope.
      expect(where.measuredAt).toBeUndefined();
    }
  });

  it("scans exactly the dense-tier types, source-scoped to APPLE_HEALTH", async () => {
    const { mock, findManyMeasurement } = buildPrismaMock({});
    await runDenseIntradayRetention(mock, { log: () => {} });

    const scannedTypes = findManyMeasurement.mock.calls.map(
      (c) => (c[0] as { where: { type: string } }).where.type,
    );
    expect(scannedTypes.sort()).toEqual(
      Array.from(DENSE_INTRADAY_RETENTION_TYPES).sort(),
    );
    for (const call of findManyMeasurement.mock.calls) {
      const where = (call[0] as unknown as { where: { source: string } }).where;
      expect(where.source).toBe("APPLE_HEALTH");
    }
  });
});

describe("runDenseIntradayRetention — hourly fold flow", () => {
  it("creates one MEAN row per LOCAL hour and soft-deletes the out-of-window rows", async () => {
    // Two HRV samples in DIFFERENT local hours (Berlin is UTC+2 on this
    // date: 08:00Z → 10:xx local, 09:00Z → 11:xx local).
    const hrvRows = [
      row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      row("b", 60, "2026-05-01T09:00:00.000Z", "HEART_RATE_VARIABILITY"),
    ];
    const { mock, create, update, updateMany } = buildPrismaMock({
      HEART_RATE_VARIABILITY: hrvRows,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    // No pre-existing canonical rows → create per hour, never update.
    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    const createArgs = create.mock.calls.map(
      (c) =>
        (
          c[0] as {
            data: {
              value: number;
              source: string;
              type: string;
              externalId: string;
              measuredAt: Date;
            };
          }
        ).data,
    );
    // Each local hour carries ITS OWN mean — the intraday shape survives at
    // hour resolution (a single daily mean of 50 would erase it).
    expect(createArgs.map((d) => d.value)).toEqual([40, 60]);
    expect(createArgs.map((d) => d.externalId)).toEqual([
      "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-01T10",
      "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-01T11",
    ]);
    // Anchored mid-hour: local HH:30 (Berlin UTC+2 → 08:30Z / 09:30Z).
    expect(createArgs.map((d) => d.measuredAt.toISOString())).toEqual([
      "2026-05-01T08:30:00.000Z",
      "2026-05-01T09:30:00.000Z",
    ]);
    for (const d of createArgs) {
      expect(d.source).toBe("APPLE_HEALTH");
      expect(d.type).toBe("HEART_RATE_VARIABILITY");
    }

    // soft-delete, never hard delete.
    const updArg = updateMany.mock.calls[0]?.[0] as {
      data: { deletedAt: Date };
    };
    expect(updArg.data.deletedAt).toBeInstanceOf(Date);
    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.hourlyRowsUpserted).toBe(2);
  });

  it("folds same-hour samples into ONE hourly mean row", async () => {
    const hrvRows = [
      row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      row("b", 60, "2026-05-01T08:40:00.000Z", "HEART_RATE_VARIABILITY"),
    ];
    const { mock, create } = buildPrismaMock({
      HEART_RATE_VARIABILITY: hrvRows,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    expect(create).toHaveBeenCalledTimes(1);
    const createArg = create.mock.calls[0]?.[0] as {
      data: { value: number };
    };
    // MEAN of (40, 60) = 50 for the shared local hour.
    expect(createArg.data.value).toBeCloseTo(50, 6);
    expect(summary.totals.hourlyRowsUpserted).toBe(1);
  });

  it("adopts an existing canonical row in place instead of colliding (P2002 coexistence)", async () => {
    const hrvRows = [
      row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
    ];
    // A row already sits on the hourly slot (externalId or anchor).
    const { mock, create, update, updateMany } = buildPrismaMock(
      { HEART_RATE_VARIABILITY: hrvRows },
      "existing-canonical-row",
    );

    await runDenseIntradayRetention(mock, { retentionDays: 0, log: () => {} });

    // The fold adopts the existing row in place — no create (which would
    // collide on the measured_at unique index), an update with the hourly
    // stats externalId + refreshed mean.
    expect(create).not.toHaveBeenCalled();
    const updateArg = update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { value: number; externalId: string; deletedAt: null };
    };
    expect(updateArg.where.id).toBe("existing-canonical-row");
    expect(updateArg.data.value).toBeCloseTo(40, 6);
    expect(updateArg.data.externalId).toBe(
      "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-01T10",
    );
    expect(updateArg.data.deletedAt).toBeNull();

    // The soft-delete excludes the adopted canonical row ids.
    const updManyArg = updateMany.mock.calls[0]?.[0] as {
      where: { id: { notIn: string[] } };
    };
    expect(updManyArg.where.id.notIn).toContain("existing-canonical-row");
  });

  it("retires a live pre-hourly DAILY stats row in the same fold transaction", async () => {
    const hrvRows = [
      row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
    ];
    const { mock, update, findFirst, $transaction } = (() => {
      const built = buildPrismaMock({ HEART_RATE_VARIABILITY: hrvRows });
      return {
        ...built,
        $transaction: built.mock.$transaction as ReturnType<typeof vi.fn>,
      };
    })();

    // Discriminating lookup mock: the hourly slot lookups miss, the daily
    // retirement lookup (keyed by the DAILY `stats:` externalId + live
    // filter) hits.
    findFirst.mockImplementation(
      async (args: { where: { externalId?: string; deletedAt?: null } }) =>
        args.where.externalId ===
          "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-01" &&
        args.where.deletedAt === null
          ? { id: "daily-legacy-row" }
          : null,
    );

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    // The daily row is tombstoned inside the (single) fold transaction —
    // never a moment where the daily and hourly rows are both live.
    expect($transaction).toHaveBeenCalledTimes(1);
    const retire = update.mock.calls.find(
      (c) =>
        (c[0] as { where: { id: string } }).where.id === "daily-legacy-row",
    );
    expect(retire).toBeDefined();
    expect(
      (retire?.[0] as { data: { deletedAt: Date } }).data.deletedAt,
    ).toBeInstanceOf(Date);
    expect(summary.totals.dailyRowsRetired).toBe(1);
  });

  it("does not write on a dry-run", async () => {
    const { mock, create, update } = buildPrismaMock({
      HEART_RATE_VARIABILITY: [
        row("a", 40, "2026-05-01T08:00:00.000Z", "HEART_RATE_VARIABILITY"),
      ],
    });
    await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      dryRun: true,
      log: () => {},
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });
});
