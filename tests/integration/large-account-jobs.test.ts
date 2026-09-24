/**
 * Issue #1031 — maintenance jobs on a large account.
 *
 * A self-hoster with 1.25 million measurement rows (a multi-year Apple Health
 * export) saw the dense intra-day retention, the nightly drain tick and the
 * data backup all fail with `job timed out`. Reproduced against a seeded
 * account of the same size (`scripts/seed-large-account.ts`): the drains held
 * a type's whole history in memory before folding a day, spent about 90
 * statements per folded day, and paged with a cursor Postgres could not use as
 * an index condition; the backup added about 640 MB to the process to store
 * one 64 MB row. pg-boss declared the jobs dead at their expiry without
 * stopping them.
 *
 * A million rows do not fit a test run, so this file pins the properties the
 * fix rests on at a scale that does: a pass that runs out of budget stops
 * cleanly and the next run finishes the job with the same result as one
 * uninterrupted run, and the backup is stored piecewise with the previous
 * copy intact if a run fails halfway.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import { consolidateDailyMean } from "@/lib/measurements/consolidate-daily-mean";
import { unpackBackupBlob } from "@/lib/export/backup-blob";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";

const TZ = "Europe/Berlin";
const RUN_A = "user-1031-stopped";
const RUN_B = "user-1031-straight";
const DAYS = 12;
/** Oldest seeded instant: well outside the 90-day raw window. */
const START = Date.UTC(2026, 0, 1, 0, 7);

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  for (const id of [RUN_A, RUN_B]) {
    await prisma.user.create({
      data: { id, username: id, email: `${id}@example.test`, timezone: TZ },
    });
  }
});

/** The same history for both users: heart rate every 20 minutes, HRV hourly. */
async function seedHistory(userId: string): Promise<void> {
  const rows = [];
  for (let minute = 0; minute < DAYS * 24 * 60; minute += 20) {
    const at = new Date(START + minute * 60_000);
    rows.push({
      userId,
      type: "PULSE" as const,
      value: 55 + ((minute / 20) % 40),
      unit: "bpm",
      source: "APPLE_HEALTH" as const,
      measuredAt: at,
      externalId: `hk-hr-${minute}`,
    });
    if (minute % 60 === 0) {
      rows.push({
        userId,
        type: "HEART_RATE_VARIABILITY" as const,
        value: 30 + ((minute / 60) % 25),
        unit: "ms",
        source: "APPLE_HEALTH" as const,
        measuredAt: at,
        externalId: `hk-hrv-${minute}`,
      });
    }
    if (minute % 40 === 0) {
      rows.push({
        userId,
        type: "WALKING_SPEED" as const,
        value: 4 + ((minute / 40) % 10) / 10,
        unit: "km/h",
        source: "APPLE_HEALTH" as const,
        measuredAt: at,
        externalId: `hk-ws-${minute}`,
      });
    }
  }
  await getPrismaClient().measurement.createMany({ data: rows });
}

/** What a reader sees: every live row, identity-free. */
async function liveRows(userId: string) {
  const rows = await getPrismaClient().measurement.findMany({
    where: { userId, deletedAt: null },
    select: {
      type: true,
      value: true,
      unit: true,
      source: true,
      measuredAt: true,
      externalId: true,
    },
    orderBy: [{ type: "asc" }, { measuredAt: "asc" }],
  });
  return rows.map((row) => ({
    ...row,
    measuredAt: row.measuredAt.toISOString(),
  }));
}

/** A `shouldStop` that lets `days` day buckets through, then says stop. */
function afterDays(days: number): () => boolean {
  let left = days;
  return () => left-- <= 0;
}

describe("a pass that runs out of budget (#1031)", () => {
  it("dense retention: stops cleanly, and the next run ends where one straight run ends", async () => {
    await seedHistory(RUN_A);
    await seedHistory(RUN_B);
    const prisma = getPrismaClient();

    const first = await runDenseIntradayRetention(prisma, {
      userId: RUN_A,
      shouldStop: afterDays(5),
      log: () => {},
    });
    expect(first.stoppedEarly).toBe(true);
    expect(first.totals.daysConsolidated).toBe(5);

    // What the stopped run folded is committed: the next scan no longer sees
    // it, so the second run folds only what is left.
    const second = await runDenseIntradayRetention(prisma, {
      userId: RUN_A,
      log: () => {},
    });
    expect(second.stoppedEarly).toBe(false);

    const straight = await runDenseIntradayRetention(prisma, {
      userId: RUN_B,
      log: () => {},
    });
    expect(first.totals.daysConsolidated + second.totals.daysConsolidated).toBe(
      straight.totals.daysConsolidated,
    );
    expect(
      first.totals.perSampleRowsSoftDeleted +
        second.totals.perSampleRowsSoftDeleted,
    ).toBe(straight.totals.perSampleRowsSoftDeleted);

    // A third run finds nothing: the pass converged.
    const third = await runDenseIntradayRetention(prisma, {
      userId: RUN_A,
      log: () => {},
    });
    expect(third.totals.daysConsolidated).toBe(0);

    const stoppedResult = (await liveRows(RUN_A)).filter(
      (row) => row.type !== "WALKING_SPEED",
    );
    const straightResult = (await liveRows(RUN_B)).filter(
      (row) => row.type !== "WALKING_SPEED",
    );
    expect(stoppedResult.length).toBeGreaterThan(0);
    expect(stoppedResult).toEqual(straightResult);
  });

  it("daily-mean consolidation: the same, for the nightly tick's middle pass", async () => {
    await seedHistory(RUN_A);
    await seedHistory(RUN_B);
    const prisma = getPrismaClient();

    const first = await consolidateDailyMean(prisma, {
      userId: RUN_A,
      shouldStop: afterDays(4),
      log: () => {},
    });
    expect(first.stoppedEarly).toBe(true);
    expect(first.totals.daysConsolidated).toBe(4);
    await consolidateDailyMean(prisma, { userId: RUN_A, log: () => {} });
    await consolidateDailyMean(prisma, { userId: RUN_B, log: () => {} });

    const stopped = (await liveRows(RUN_A)).filter(
      (row) => row.type === "WALKING_SPEED",
    );
    const straight = (await liveRows(RUN_B)).filter(
      (row) => row.type === "WALKING_SPEED",
    );
    // One daily mean per local day: twelve UTC days touch thirteen Berlin days.
    expect(stopped).toHaveLength(DAYS + 1);
    expect(stopped).toEqual(straight);
  });
});

describe("storeBackupBlob (#1031)", () => {
  /** A producer writing `rows` JSON rows in small pieces. */
  function producer(rows: number, failAfter?: number) {
    return async (write: (chunk: string) => Promise<void>) => {
      await write('{"measurements":[');
      for (let i = 0; i < rows; i++) {
        if (failAfter !== undefined && i === failAfter) {
          throw new Error("record read failed halfway");
        }
        await write(
          `${i === 0 ? "" : ","}${JSON.stringify({ id: `m-${i}`, value: i })}`,
        );
      }
      await write("]}");
    };
  }

  function expectedJson(rows: number): string {
    return JSON.stringify({
      measurements: Array.from({ length: rows }, (_, i) => ({
        id: `m-${i}`,
        value: i,
      })),
    });
  }

  it("stores a copy that reads back as exactly the JSON produced", async () => {
    const prisma = getPrismaClient();
    const bytes = await storeBackupBlob(
      prisma,
      { userId: RUN_A, type: "WEEKLY_AUTO" },
      producer(20_000),
    );

    const row = await prisma.dataBackup.findUniqueOrThrow({
      where: { userId_type: { userId: RUN_A, type: "WEEKLY_AUTO" } },
    });
    expect(row.data.length).toBe(bytes);
    expect(unpackBackupBlob(row.data)).toBe(expectedJson(20_000));
  });

  it("keeps the previous copy when a run fails halfway, and the next run still stores", async () => {
    const prisma = getPrismaClient();
    await storeBackupBlob(
      prisma,
      { userId: RUN_A, type: "WEEKLY_AUTO" },
      producer(10),
    );
    const before = await prisma.dataBackup.findUniqueOrThrow({
      where: { userId_type: { userId: RUN_A, type: "WEEKLY_AUTO" } },
    });

    await expect(
      storeBackupBlob(
        prisma,
        { userId: RUN_A, type: "WEEKLY_AUTO" },
        producer(20_000, 15_000),
      ),
    ).rejects.toThrow("record read failed halfway");

    const after = await prisma.dataBackup.findUniqueOrThrow({
      where: { userId_type: { userId: RUN_A, type: "WEEKLY_AUTO" } },
    });
    expect(after.data).toBe(before.data);
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());

    // The temporary table went with the failed transaction.
    await storeBackupBlob(
      prisma,
      { userId: RUN_A, type: "WEEKLY_AUTO" },
      producer(30),
    );
    const replaced = await prisma.dataBackup.findUniqueOrThrow({
      where: { userId_type: { userId: RUN_A, type: "WEEKLY_AUTO" } },
    });
    expect(unpackBackupBlob(replaced.data)).toBe(expectedJson(30));
  });
});
