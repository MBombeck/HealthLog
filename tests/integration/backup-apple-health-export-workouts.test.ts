/**
 * A backup written before #1414 brings its export workout copies back.
 *
 * Such a file can hold one Apple Health export workout several times, each
 * under an old per-spelling `sample:` key, and migration 0513 does not run
 * again after a restore. The restore collapses them the way the migration
 * does: one row under the key the importer computes now, the oldest kept,
 * its empty totals filled from a copy, and a personal record that names a
 * copy following the kept row. Through the real backup slice and restore,
 * against Postgres.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { restoreAwardsData } from "@/lib/export/awards-backup";
import {
  emptyRestoreLinks,
  type RestoreContext,
} from "@/lib/export/restore-context";
import {
  buildWorkoutsBackupSlice,
  clearWorkouts,
  restoreWorkouts,
} from "@/lib/export/workouts-backup";
import { workoutExternalId } from "@/lib/measurements/apple-health-export-workouts";
import { hashSampleKey } from "@/lib/measurements/import-apple-health-export";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER = "export-workout-restore";
const prisma = getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, email: `${USER}@example.test` },
  });
});

const ACTIVITY = "HKWorkoutActivityTypeRunning";
const START = new Date("2026-05-14T16:00:00.000Z");
const END = new Date("2026-05-14T16:42:00.000Z");
/** The same session as three exports spelled it. */
const SPELLINGS = [
  ["42", "2026-05-14 18:00:00 +0200", "2026-05-14 18:42:00 +0200"],
  [
    "42.00000166893005",
    "2026-05-14 17:00:00 +0100",
    "2026-05-14 17:42:00 +0100",
  ],
  [
    "42.0000016689301",
    "2026-05-14 16:00:00 +0000",
    "2026-05-14 16:42:00 +0000",
  ],
] as const;

describe("restoring export workouts stored under the old keys", () => {
  it("collapses the copies onto one row under the new key", async () => {
    const keys = SPELLINGS.map(([duration, start, end]) =>
      hashSampleKey(ACTIVITY, duration, start, end),
    );
    expect(new Set(keys).size).toBe(3);
    for (const [i, externalId] of keys.entries()) {
      await prisma.workout.create({
        data: {
          id: `w-${i}`,
          userId: USER,
          sportType: "RUN",
          startedAt: START,
          endedAt: END,
          durationSec: 2520,
          // The oldest copy lacks the energy a later one states.
          totalEnergyKcal: i === 2 ? 412.5 : null,
          totalDistanceM: i === 0 ? 7000 : 6900,
          source: "APPLE_HEALTH",
          externalId,
          metadata: { activityType: ACTIVITY, sourceName: "Watch" },
          createdAt: new Date(`2026-0${6 + i}-01T00:00:00.000Z`),
        },
      });
    }
    // A manual workout at the same time is not an export copy.
    await prisma.workout.create({
      data: {
        id: "w-manual",
        userId: USER,
        sportType: "RUN",
        startedAt: START,
        endedAt: END,
        durationSec: 2520,
        source: "MANUAL",
      },
    });
    const best = {
      metricType: "WALKING_RUNNING_DISTANCE",
      metricSlot: "running_longest",
      direction: "MAX",
      value: 6900,
      unit: "m",
      achievedAt: START.toISOString(),
      source: "APPLE_HEALTH",
      externalId: keys[1],
    } as const;

    const slice = await buildWorkoutsBackupSlice(prisma, USER, true);
    expect(slice.workouts).toHaveLength(4);

    const links = emptyRestoreLinks();
    await prisma.$transaction(async (tx) => {
      const ctx = {
        tx,
        ownerId: USER,
        cleared: {},
        links,
        payload: {
          workouts: slice.workouts,
        },
      } as unknown as RestoreContext;
      await clearWorkouts(ctx);
      await restoreWorkouts(ctx);
      await restoreAwardsData(
        tx,
        USER,
        { personalRecords: [best], userAchievements: [] },
        new Set(),
        [],
        links.workoutKeyByLegacyKey,
      );
    });

    const rows = await prisma.workout.findMany({
      where: { userId: USER, source: "APPLE_HEALTH" },
    });
    expect(rows).toHaveLength(1);
    const newKey = workoutExternalId(ACTIVITY, START, END);
    expect(rows[0]).toMatchObject({
      id: "w-0",
      externalId: newKey,
      totalDistanceM: 7000,
      totalEnergyKcal: 412.5,
    });
    expect(
      await prisma.workout.count({ where: { userId: USER, source: "MANUAL" } }),
    ).toBe(1);
    const record = await prisma.personalRecord.findFirstOrThrow({
      where: { userId: USER },
    });
    expect(record.externalId).toBe(newKey);
  });
});
