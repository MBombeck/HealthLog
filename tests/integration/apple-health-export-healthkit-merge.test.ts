/**
 * An Apple Health workout is one row whether the iPhone app, an export, or
 * both stored it (#1414). Against Postgres:
 *
 *   - an export imported over a workout the app synced fills what the app's
 *     row leaves empty and stores nothing new, however often it is imported;
 *   - a workout the app syncs over an export row takes that row's data, its
 *     track and its personal records, and the export row goes;
 *   - migration 0562 merges the pairs stored before this, by the same rule
 *     and to the same row the writes produce, and a second run changes
 *     nothing;
 *   - a backup taken after the merge restores the one row, and a backup taken
 *     before it restores one row too.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { streamParseExportXml } from "@/lib/measurements/import-apple-health-export";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-workout-export-merge-integration-32-bytes-min-12345";
process.env.ENCRYPTION_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

const prisma = getPrismaClient();
const USER = "user-workout-export-merge";

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/0562_apple_health_workout_export_pairs/migration.sql",
  ),
  "utf8",
);

/** The file's DO block, as `migrate deploy` runs it. */
async function applyMigration(): Promise<void> {
  const blocks = MIGRATION.split(/(?<=\$migration\$;)/)
    .map((block) =>
      block
        .replace(/^(\s*--[^\n]*\n)*/g, "")
        .replace(/^\s*SET LOCAL statement_timeout[^;]*;/, "")
        .trim(),
    )
    .filter((block) => block.startsWith("DO"));
  expect(blocks).toHaveLength(1);
  for (const block of blocks) await prisma.$executeRawUnsafe(block);
}

const WALK = "HKWorkoutActivityTypeWalking";
const UUID = "6C1E6A0F-0D4B-4C2F-9F0A-6E3B2D1C0A9F";
const START = new Date("2026-08-21T16:36:16.000Z");
const END = new Date("2026-08-21T17:31:32.000Z");
const DURATION = 3316;
const EXPORT_KEY = workoutExternalId(WALK, START, END);

beforeEach(async () => {
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
  await prisma.user.create({
    data: {
      id: USER,
      username: "workout-export-merge",
      email: "workout-export-merge@example.test",
      timezone: "America/Denver",
    },
  });
  const session = await prisma.session.create({
    data: { userId: USER, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  cookieJar.set("healthlog_session", session.id);
});

/** The same walk as the reporter's two exports wrote it, with statistics. */
function exportXml(): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "healthlog-export-healthkit-")),
    "export.xml",
  );
  const start = "2026-08-21 10:36:16 -0600";
  const end = "2026-08-21 11:31:32 -0600";
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<Workout workoutActivityType="${WALK}" duration="55.26666666666667" durationUnit="min" sourceName="" sourceVersion="54910" startDate="${start}" endDate="${end}">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="${start}" endDate="${end}" sum="260" unit="Cal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="${start}" endDate="${end}" sum="4.2" unit="km"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="${start}" endDate="${end}" average="121" minimum="90" maximum="150" unit="count/min"/>
</Workout>
</HealthData>`,
  );
  return path;
}

async function importExport() {
  return streamParseExportXml({
    xmlPath: exportXml(),
    userId: USER,
    userTimezone: "America/Denver",
    prisma,
  });
}

const SERIES = [
  { t: "2026-08-21T16:36:16.000Z", hr: 110 },
  { t: "2026-08-21T16:36:21.000Z", hr: 116 },
];

/** The walk as the iPhone app syncs it. */
async function syncFromPhone() {
  const { POST } = await import("@/app/api/workouts/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/workouts/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workouts: [
          {
            sportType: "walking",
            startedAt: START.toISOString(),
            endedAt: END.toISOString(),
            totalEnergyKcal: 250,
            avgHeartRate: 118,
            source: "APPLE_HEALTH",
            externalId: UUID,
            samples: SERIES,
          },
        ],
      }),
    }),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as { data: { entries: Array<{ status: string }> } }
  ).data;
}

async function workouts() {
  return prisma.workout.findMany({
    where: { userId: USER },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

/** What the phone's row holds once merged, whichever side came first. */
const MERGED = {
  externalId: UUID,
  sportType: "walking",
  durationSec: DURATION,
  // The phone's own figures stay.
  totalEnergyKcal: 250,
  avgHeartRate: 118,
  // What the phone left empty, from the export's statistics.
  totalDistanceM: 4200,
  minHeartRate: 90,
  maxHeartRate: 150,
  externalSourceVersion: "54910",
};

describe("an export imported over a workout the phone synced", () => {
  it("fills the phone's row and stores nothing new, on every import", async () => {
    await syncFromPhone();

    const first = await importExport();
    expect(first.workouts).toMatchObject({
      inserted: 0,
      updated: 1,
      mergedIntoHealthKit: 1,
    });
    let rows = await workouts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(MERGED);
    const series = await prisma.workoutSamples.findUniqueOrThrow({
      where: { workoutId: rows[0].id },
    });
    expect(series.sampleCount).toBe(2);

    const second = await importExport();
    expect(second.workouts).toMatchObject({ inserted: 0, updated: 1 });
    rows = await workouts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(MERGED);
  });
});

describe("a workout the phone syncs over an export row", () => {
  it("takes the export row's data, track and records, and the export row goes", async () => {
    await importExport();
    const [exported] = await workouts();
    expect(exported.externalId).toBe(EXPORT_KEY);
    await prisma.workoutRoute.create({
      data: {
        workoutId: exported.id,
        geometry: { type: "LineString", coordinates: [[-105.2, 40.0]] },
      },
    });
    const record = await prisma.personalRecord.create({
      data: {
        userId: USER,
        metricType: "WALKING_RUNNING_DISTANCE",
        metricSlot: "walking_longest_distance",
        direction: "MAX",
        value: 4200,
        unit: "m",
        achievedAt: START,
        source: "APPLE_HEALTH",
        externalId: EXPORT_KEY,
      },
    });

    const synced = await syncFromPhone();
    expect(synced.entries[0].status).toBe("inserted");

    const rows = await workouts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(MERGED);
    expect(
      await prisma.workoutRoute.findUnique({
        where: { workoutId: rows[0].id },
      }),
    ).not.toBeNull();
    expect(
      await prisma.workoutSamples.findUnique({
        where: { workoutId: rows[0].id },
      }),
    ).not.toBeNull();
    expect(
      (
        await prisma.personalRecord.findUniqueOrThrow({
          where: { id: record.id },
        })
      ).externalId,
    ).toBe(UUID);

    // The next export finds the phone's row again.
    const again = await importExport();
    expect(again.workouts).toMatchObject({
      inserted: 0,
      mergedIntoHealthKit: 1,
    });
    expect(await workouts()).toHaveLength(1);
  });
});

/** A stored pair, as releases before this one left it. */
async function seedPair() {
  const phone = await prisma.workout.create({
    data: {
      userId: USER,
      sportType: "walking",
      startedAt: START,
      endedAt: END,
      durationSec: DURATION,
      totalEnergyKcal: 250,
      avgHeartRate: 118,
      source: "APPLE_HEALTH",
      externalId: UUID,
      createdAt: new Date("2026-08-21T18:00:00.000Z"),
    },
  });
  await prisma.workoutSamples.create({
    data: { workoutId: phone.id, samples: SERIES, sampleCount: 2 },
  });
  const exported = await prisma.workout.create({
    data: {
      userId: USER,
      sportType: "walking",
      startedAt: START,
      endedAt: END,
      durationSec: DURATION,
      totalEnergyKcal: 260,
      totalDistanceM: 4200,
      avgHeartRate: 121,
      minHeartRate: 90,
      maxHeartRate: 150,
      source: "APPLE_HEALTH",
      externalId: EXPORT_KEY,
      externalSourceVersion: "54910",
      metadata: { activityType: WALK, sourceName: "" },
      createdAt: new Date("2026-11-18T09:00:00.000Z"),
    },
  });
  await prisma.workoutRoute.create({
    data: {
      workoutId: exported.id,
      geometry: { type: "LineString", coordinates: [[-105.2, 40.0]] },
    },
  });
  const record = await prisma.personalRecord.create({
    data: {
      userId: USER,
      metricType: "WALKING_RUNNING_DISTANCE",
      metricSlot: "walking_longest_distance",
      direction: "MAX",
      value: 4200,
      unit: "m",
      achievedAt: START,
      source: "APPLE_HEALTH",
      externalId: EXPORT_KEY,
    },
  });
  // Not pairs: an export walk a second longer, and an export ride.
  const longer = await prisma.workout.create({
    data: {
      userId: USER,
      sportType: "walking",
      startedAt: START,
      endedAt: new Date(END.getTime() + 1000),
      durationSec: DURATION + 1,
      source: "APPLE_HEALTH",
      externalId: workoutExternalId(
        WALK,
        START,
        new Date(END.getTime() + 1000),
      ),
    },
  });
  const ride = await prisma.workout.create({
    data: {
      userId: USER,
      sportType: "cycling",
      startedAt: START,
      endedAt: END,
      durationSec: DURATION,
      source: "APPLE_HEALTH",
      externalId: workoutExternalId("HKWorkoutActivityTypeCycling", START, END),
    },
  });
  return { phone, exported, record, others: [longer.id, ride.id] };
}

describe("migration 0562 on the pairs already stored", () => {
  it("merges each pair into the phone's row as the writes do, once", async () => {
    const { phone, record, others } = await seedPair();

    await applyMigration();

    const rows = await workouts();
    expect(rows.map((row) => row.id).sort()).toEqual(
      [phone.id, ...others].sort(),
    );
    const kept = rows.find((row) => row.id === phone.id)!;
    // The same row the write path builds from the same two workouts.
    expect(kept).toMatchObject(MERGED);
    expect(
      await prisma.workoutRoute.findUnique({ where: { workoutId: phone.id } }),
    ).not.toBeNull();
    expect(
      (
        await prisma.workoutSamples.findUniqueOrThrow({
          where: { workoutId: phone.id },
        })
      ).sampleCount,
    ).toBe(2);
    expect(
      (
        await prisma.personalRecord.findUniqueOrThrow({
          where: { id: record.id },
        })
      ).externalId,
    ).toBe(UUID);

    // A second application changes nothing.
    const before = await workouts();
    await applyMigration();
    expect(await workouts()).toEqual(before);
  });
});

/** Back up and restore the account's workouts and records in one go. */
async function roundTrip() {
  const slice = await buildWorkoutsBackupSlice(prisma, USER, true);
  const records = await prisma.personalRecord.findMany({
    where: { userId: USER },
  });
  const links = emptyRestoreLinks();
  await prisma.$transaction(async (tx) => {
    const ctx = {
      tx,
      ownerId: USER,
      cleared: {},
      links,
      payload: { workouts: slice.workouts },
    } as unknown as RestoreContext;
    await clearWorkouts(ctx);
    await restoreWorkouts(ctx);
    await restoreAwardsData(
      tx,
      USER,
      {
        personalRecords: records.map((r) => ({
          metricType: r.metricType,
          metricSlot: r.metricSlot,
          direction: r.direction,
          value: r.value,
          unit: r.unit,
          achievedAt: r.achievedAt.toISOString(),
          source: r.source,
          externalId: r.externalId,
        })),
        userAchievements: [],
      } as never,
      new Set(),
      [],
      links.workoutKeyByLegacyKey,
    );
  });
  return slice.workouts.length;
}

describe("backup and restore", () => {
  it("restores the merged row after the migration", async () => {
    const { phone } = await seedPair();
    await applyMigration();
    const before = await workouts();

    expect(await roundTrip()).toBe(3);

    const after = await workouts();
    expect(after).toHaveLength(3);
    const kept = after.find((row) => row.id === phone.id)!;
    expect(kept).toMatchObject(MERGED);
    const { updatedAt: _a, ...keptBefore } = before.find(
      (row) => row.id === phone.id,
    )!;
    const { updatedAt: _b, ...keptAfter } = kept;
    expect(keptAfter).toEqual(keptBefore);
  });

  it("merges a pair a backup from before the migration still holds", async () => {
    const { phone } = await seedPair();

    expect(await roundTrip()).toBe(4);

    const rows = await workouts();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.id === phone.id)).toMatchObject(MERGED);
    const [record] = await prisma.personalRecord.findMany({
      where: { userId: USER },
    });
    expect(record.externalId).toBe(UUID);
  });
});
