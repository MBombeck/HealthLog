/**
 * Migration 0420 moves the RMSSD rows Fitbit and Google Health wrote into the
 * SDNN series over to `HRV_RMSSD`, and clears the derived state that kept the
 * old filing: their SDNN rollup buckets, the RMSSD buckets of the accounts
 * whose rows moved (so the boot-time discovery folds them again), and the
 * SDNN personal records those rows set. Apple Health SDNN and WHOOP RMSSD are
 * left exactly as they were, and a rerun changes nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { enqueueBootTimeRollupBackfill } from "@/lib/rollups/full-backfill";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

const prisma = getPrismaClient();
const USER = "hrv-rmssd-migration";
const BYSTANDER = "hrv-rmssd-migration-apple-only";

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma",
    "migrations",
    "0420_hrv_rmssd_from_fitbit_and_google_health",
    "migration.sql",
  ),
  "utf8",
);

async function runMigration(): Promise<void> {
  // The file is one `DO` block; the comments around it are harmless.
  await prisma.$executeRawUnsafe(MIGRATION);
}

const DAY_MS = 86_400_000;
/** Ten days ago at 07:00 UTC, so every row sits inside the fold window. */
const D0 =
  Math.floor(Date.now() / DAY_MS) * DAY_MS - 10 * DAY_MS + 7 * 3_600_000;
const dayKey = (i: number) =>
  new Date(D0 + i * DAY_MS).toISOString().slice(0, 10);

function rows(): Prisma.MeasurementCreateManyInput[] {
  const out: Prisma.MeasurementCreateManyInput[] = [];
  for (let i = 0; i < 4; i += 1) {
    const at = new Date(D0 + i * DAY_MS);
    out.push(
      {
        id: `fitbit-${i}`,
        userId: USER,
        type: "HEART_RATE_VARIABILITY",
        source: "FITBIT",
        unit: "ms",
        value: 40 + i,
        measuredAt: at,
        externalId: `${dayKey(i)}:hrv`,
      },
      {
        id: `apple-${i}`,
        userId: USER,
        type: "HEART_RATE_VARIABILITY",
        source: "APPLE_HEALTH",
        unit: "ms",
        value: 70 + i,
        measuredAt: new Date(at.getTime() + 3_600_000),
      },
      // WHOOP covers the same nights in the RMSSD series already: the moved
      // Fitbit rows land on days that already have an RMSSD bucket.
      {
        id: `whoop-${i}`,
        userId: USER,
        type: "HRV_RMSSD",
        source: "WHOOP",
        unit: "ms",
        value: 55 + i,
        measuredAt: new Date(at.getTime() + 1_800_000),
        externalId: `sleep-${i}:hrv_rmssd`,
      },
      {
        id: `bystander-${i}`,
        userId: BYSTANDER,
        type: "HEART_RATE_VARIABILITY",
        source: "APPLE_HEALTH",
        unit: "ms",
        value: 80 + i,
        measuredAt: at,
      },
    );
  }
  out.push(
    {
      // On a night WHOOP covers too: every live moved row lands on a day that
      // already has an RMSSD bucket, so only the dropped buckets can get the
      // account flagged for a fold.
      id: "google-0",
      userId: USER,
      type: "HEART_RATE_VARIABILITY",
      source: "GOOGLE_HEALTH",
      unit: "ms",
      value: 44,
      measuredAt: new Date(D0 + DAY_MS + 7_200_000),
      externalId: `${dayKey(1)}:hrv`,
    },
    // A tombstone moves too, so the sync feed reports one type for the id.
    {
      id: "fitbit-deleted",
      userId: USER,
      type: "HEART_RATE_VARIABILITY",
      source: "FITBIT",
      unit: "ms",
      value: 39,
      measuredAt: new Date(D0 + 6 * DAY_MS),
      externalId: `${dayKey(6)}:hrv`,
      deletedAt: new Date(),
    },
  );
  return out;
}

type RollupRow = { type: string; source: string; granularity: string };
const rollups = (userId: string) =>
  prisma.$queryRaw<RollupRow[]>`
    SELECT "type"::text AS type, "source"::text AS source,
           "granularity"::text AS granularity
    FROM measurement_rollups
    WHERE "user_id" = ${userId}
    ORDER BY 1, 2, 3
  `;
const pairs = (all: RollupRow[]) =>
  [...new Set(all.map((r) => `${r.type}/${r.source}`))].sort();

let bystanderBefore: RollupRow[] = [];

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.createMany({
    data: [
      { id: USER, username: USER, timezone: "UTC" },
      { id: BYSTANDER, username: BYSTANDER, timezone: "UTC" },
    ],
  });
  await prisma.measurement.createMany({ data: rows() });
  await recomputeUserRollups(USER);
  await recomputeUserRollups(BYSTANDER);
  await prisma.personalRecord.createMany({
    data: [
      {
        userId: USER,
        metricType: "HEART_RATE_VARIABILITY",
        direction: "MAX",
        value: 43,
        unit: "ms",
        achievedAt: new Date(D0 + 3 * DAY_MS),
        source: "FITBIT",
        sourceMeasurementId: "fitbit-3",
      },
      {
        userId: USER,
        metricType: "HEART_RATE_VARIABILITY",
        direction: "MAX",
        value: 73,
        unit: "ms",
        achievedAt: new Date(D0 + 3 * DAY_MS + 3_600_000),
        source: "APPLE_HEALTH",
        sourceMeasurementId: "apple-3",
      },
    ],
  });
  bystanderBefore = await rollups(BYSTANDER);
  await runMigration();
}, 120_000);

describe("migration 0420", () => {
  it("moves every Fitbit and Google Health SDNN row to HRV_RMSSD, tombstones included", async () => {
    const moved = await prisma.measurement.findMany({
      where: { userId: USER, source: { in: ["FITBIT", "GOOGLE_HEALTH"] } },
      select: { id: true, type: true, syncVersion: true, value: true },
      orderBy: { id: "asc" },
    });
    expect(moved).toHaveLength(6);
    for (const row of moved) {
      expect(row.type, row.id).toBe("HRV_RMSSD");
      // A type change must reach the phone through the sync feed.
      expect(row.syncVersion, row.id).toBe(2);
    }
  });

  it("leaves Apple Health SDNN and WHOOP RMSSD rows alone", async () => {
    const apple = await prisma.measurement.findMany({
      where: { source: "APPLE_HEALTH" },
      select: { type: true, syncVersion: true },
    });
    expect(apple).toHaveLength(8);
    expect(apple.every((r) => r.type === "HEART_RATE_VARIABILITY")).toBe(true);
    expect(apple.every((r) => r.syncVersion === 1)).toBe(true);
    const whoop = await prisma.measurement.findMany({
      where: { source: "WHOOP" },
      select: { type: true, syncVersion: true },
    });
    expect(whoop.every((r) => r.type === "HRV_RMSSD")).toBe(true);
    expect(whoop.every((r) => r.syncVersion === 1)).toBe(true);
  });

  it("drops the SDNN buckets of the moved sources and the account's RMSSD buckets", async () => {
    expect(pairs(await rollups(USER))).toEqual([
      "HEART_RATE_VARIABILITY/APPLE_HEALTH",
    ]);
    expect(await rollups(BYSTANDER)).toEqual(bystanderBefore);
  });

  it("leaves the account where the boot-time discovery folds it again", async () => {
    const send = vi.fn(async () => "job-id");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    try {
      const result = await enqueueBootTimeRollupBackfill();
      expect(result.error).toBeNull();
      const users = send.mock.calls.map(
        (call) => (call as unknown as [string, { userId: string }])[1].userId,
      );
      expect(users).toContain(USER);
      expect(users).not.toContain(BYSTANDER);
    } finally {
      vi.mocked(getGlobalBoss).mockReturnValue(null as never);
    }
  });

  it("refolds into an RMSSD series that carries both straps", async () => {
    await recomputeUserRollups(USER);
    expect(pairs(await rollups(USER))).toEqual([
      "HEART_RATE_VARIABILITY/APPLE_HEALTH",
      "HRV_RMSSD/FITBIT",
      "HRV_RMSSD/GOOGLE_HEALTH",
      "HRV_RMSSD/WHOOP",
    ]);
  });

  it("deletes the SDNN records the moved rows set and keeps the rest", async () => {
    const records = await prisma.personalRecord.findMany({
      where: { userId: USER },
      select: { source: true, metricType: true },
    });
    expect(records).toEqual([
      { source: "APPLE_HEALTH", metricType: "HEART_RATE_VARIABILITY" },
    ]);
  });

  it("is idempotent", async () => {
    const measurementsBefore = await prisma.measurement.findMany({
      orderBy: { id: "asc" },
    });
    const rollupsBefore = await rollups(USER);
    await runMigration();
    expect(
      await prisma.measurement.findMany({ orderBy: { id: "asc" } }),
    ).toEqual(measurementsBefore);
    expect(await rollups(USER)).toEqual(rollupsBefore);
  });
});

describe("migration 0420 with an RMSSD twin on the same night", () => {
  const TWIN_USER = "hrv-rmssd-migration-twins";
  const at = new Date(D0 + 2 * DAY_MS);

  it("tombstones the SDNN row instead of breaking the measured-at key", async () => {
    await prisma.user.create({
      data: { id: TWIN_USER, username: TWIN_USER, timezone: "UTC" },
    });
    await prisma.measurement.createMany({
      data: [
        // No externalId: only the (user, type, measuredAt, source,
        // sleepStage) identity can see the twin. Moving it would violate
        // that key and abort the whole block at boot.
        {
          id: "twin-sdnn-null-ext",
          userId: TWIN_USER,
          type: "HEART_RATE_VARIABILITY",
          source: "FITBIT",
          unit: "ms",
          value: 41,
          measuredAt: at,
          externalId: null,
        },
        {
          id: "twin-rmssd",
          userId: TWIN_USER,
          type: "HRV_RMSSD",
          source: "FITBIT",
          unit: "ms",
          value: 42,
          measuredAt: at,
          externalId: `${dayKey(2)}:hrv`,
        },
        // A different externalId on the same night of Google Health.
        {
          id: "twin-sdnn-other-ext",
          userId: TWIN_USER,
          type: "HEART_RATE_VARIABILITY",
          source: "GOOGLE_HEALTH",
          unit: "ms",
          value: 50,
          measuredAt: at,
          externalId: "older-id:hrv",
        },
        {
          id: "twin-rmssd-google",
          userId: TWIN_USER,
          type: "HRV_RMSSD",
          source: "GOOGLE_HEALTH",
          unit: "ms",
          value: 51,
          measuredAt: at,
          externalId: `${dayKey(2)}:hrv`,
        },
      ],
    });

    await runMigration();

    const after = await prisma.measurement.findMany({
      where: { userId: TWIN_USER },
      select: { id: true, type: true, value: true, deletedAt: true },
      orderBy: { id: "asc" },
    });
    expect(
      after.map((r) => [r.id, r.type, r.value, r.deletedAt !== null]),
    ).toEqual([
      ["twin-rmssd", "HRV_RMSSD", 42, false],
      ["twin-rmssd-google", "HRV_RMSSD", 51, false],
      ["twin-sdnn-null-ext", "HEART_RATE_VARIABILITY", 41, true],
      ["twin-sdnn-other-ext", "HEART_RATE_VARIABILITY", 50, true],
    ]);
  });

  it("moves a live row whose only twin is a tombstone, dropping the tombstone", async () => {
    const user = "hrv-rmssd-migration-dead-twin";
    await prisma.user.create({
      data: { id: user, username: user, timezone: "UTC" },
    });
    await prisma.measurement.createMany({
      data: [
        {
          id: "dead-twin-sdnn",
          userId: user,
          type: "HEART_RATE_VARIABILITY",
          source: "FITBIT",
          unit: "ms",
          value: 47,
          measuredAt: at,
          externalId: null,
        },
        {
          id: "dead-twin-rmssd",
          userId: user,
          type: "HRV_RMSSD",
          source: "FITBIT",
          unit: "ms",
          value: 46,
          measuredAt: at,
          externalId: `${dayKey(2)}:hrv`,
          deletedAt: new Date(),
        },
      ],
    });

    await runMigration();

    const after = await prisma.measurement.findMany({
      where: { userId: user },
      select: { id: true, type: true, deletedAt: true },
    });
    expect(after).toEqual([
      { id: "dead-twin-sdnn", type: "HRV_RMSSD", deletedAt: null },
    ]);
  });
});
