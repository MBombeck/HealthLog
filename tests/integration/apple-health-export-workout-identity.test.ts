/**
 * An export workout is one workout however often it is imported (#1414).
 *
 * The importer used to key a workout on the raw attribute strings, so a later
 * export that wrote the same session with its dates in another offset form and
 * its duration at another precision inserted it again; three imports left
 * three to six copies. Its totals sat in `<WorkoutStatistics>` children the
 * importer did not read. Against Postgres:
 *
 *   - two exports writing one workout differently give one row, updated by the
 *     second, with the statistics' totals;
 *   - migration 0513 collapses the copies already stored onto the oldest row,
 *     moves what it lacks over from a copy, re-points personal records, and
 *     gives it the key the importer now computes, so the next export updates
 *     it; a second application changes nothing.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { workoutExternalId } from "@/lib/measurements/apple-health-export-workouts";
import {
  hashSampleKey,
  streamParseExportXml,
} from "@/lib/measurements/import-apple-health-export";

import { makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/0513_apple_health_export_duplicates/migration.sql",
  ),
  "utf8",
);

/** The file's DO blocks, run one by one as `migrate deploy` runs them. */
async function applyMigration(): Promise<void> {
  const blocks = MIGRATION.split(/(?<=\$migration\$;)/)
    .map((block) => block.replace(/^(\s*--[^\n]*\n)*/g, "").trim())
    .filter((block) => block.startsWith("DO"));
  expect(blocks).toHaveLength(2);
  for (const block of blocks) await prisma.$executeRawUnsafe(block);
}

function writeExport(body: string): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "healthlog-workout-identity-")),
    "export.xml",
  );
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
${body}
</HealthData>`,
  );
  return path;
}

const RUN = "HKWorkoutActivityTypeRunning";
const START = new Date("2026-05-14T16:00:00.000Z");
const END = new Date("2026-05-14T16:42:00.000Z");

/** The same run as three exports wrote it. */
const SPELLINGS = [
  {
    duration: "42",
    start: "2026-05-14 18:00:00 +0200",
    end: "2026-05-14 18:42:00 +0200",
  },
  {
    duration: "42.00000166893005",
    start: "2026-05-14 18:00:00 +0200",
    end: "2026-05-14 18:42:00 +0200",
  },
  {
    duration: "42.0",
    start: "2026-05-14 17:00:00 +0100",
    end: "2026-05-14 17:42:00 +0100",
  },
];

let userId = "";

beforeEach(async () => {
  await truncateAllTables(prisma);
  userId = (await makeUser({ timezone: "Europe/Berlin" })).id;
});

async function importExport(body: string) {
  return streamParseExportXml({
    xmlPath: writeExport(body),
    userId,
    userTimezone: "Europe/Berlin",
    prisma,
  });
}

async function workouts() {
  return prisma.workout.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

describe("re-importing an export workout", () => {
  it("updates the one row when the second export spells it differently", async () => {
    const [a, , c] = SPELLINGS;
    const first = await importExport(
      `<Workout workoutActivityType="${RUN}" duration="${a.duration}" durationUnit="min" startDate="${a.start}" endDate="${a.end}"/>`,
    );
    expect(first.workouts.inserted).toBe(1);

    const second = await importExport(
      `<Workout workoutActivityType="${RUN}" duration="${c.duration}" durationUnit="min" startDate="${c.start}" endDate="${c.end}">
    <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="${c.start}" endDate="${c.end}" sum="412.5" unit="Cal"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" startDate="${c.start}" endDate="${c.end}" sum="6.5" unit="km"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="${c.start}" endDate="${c.end}" average="151.6" minimum="98" maximum="178" unit="count/min"/>
  </Workout>`,
    );
    expect(second.workouts).toMatchObject({ inserted: 0, updated: 1 });

    const rows = await workouts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      externalId: workoutExternalId(RUN, START, END),
      totalEnergyKcal: 412.5,
      totalDistanceM: 6500,
      avgHeartRate: 152,
      minHeartRate: 98,
      maxHeartRate: 178,
    });

    // A third export without the statistics keeps the totals.
    const third = await importExport(
      `<Workout workoutActivityType="${RUN}" duration="${a.duration}" durationUnit="min" startDate="${a.start}" endDate="${a.end}"/>`,
    );
    expect(third.workouts).toMatchObject({ inserted: 0, updated: 1 });
    const [kept] = await workouts();
    expect(kept.totalEnergyKcal).toBe(412.5);
    expect(kept.avgHeartRate).toBe(152);
  });
});

describe("migration 0513 on stored export workouts", () => {
  async function seedCopies() {
    const ids: string[] = [];
    for (const [i, s] of SPELLINGS.entries()) {
      const row = await prisma.workout.create({
        data: {
          userId,
          sportType: "running",
          startedAt: START,
          endedAt: END,
          durationSec: 2520,
          totalEnergyKcal: i === 2 ? 410 : null,
          source: "APPLE_HEALTH",
          externalId: hashSampleKey(RUN, s.duration, s.start, s.end),
          metadata: { activityType: RUN, sourceName: "Watch" },
          createdAt: new Date(Date.UTC(2026, 5, 1 + i)),
        },
      });
      ids.push(row.id);
    }
    return ids;
  }

  it("keeps the oldest copy, moves what it lacks onto it, and gives it the new key", async () => {
    const [oldest, middle, newest] = await seedCopies();
    await prisma.workoutRoute.create({
      data: {
        workoutId: middle,
        geometry: { type: "LineString", coordinates: [[7.2, 51.5]] },
      },
    });
    await prisma.workoutSamples.create({
      data: {
        workoutId: newest,
        samples: [{ t: START.toISOString(), hr: 140 }],
        sampleCount: 1,
      },
    });
    const record = await prisma.personalRecord.create({
      data: {
        userId,
        metricType: "WALKING_RUNNING_DISTANCE",
        metricSlot: "running_longest_distance",
        direction: "MAX",
        value: 6500,
        unit: "m",
        achievedAt: START,
        source: "APPLE_HEALTH",
        externalId: hashSampleKey(
          RUN,
          SPELLINGS[1].duration,
          SPELLINGS[1].start,
          SPELLINGS[1].end,
        ),
      },
    });
    // Another workout of the same account, and the same run of another
    // account, stay apart.
    const ride = await prisma.workout.create({
      data: {
        userId,
        sportType: "cycling",
        startedAt: START,
        endedAt: END,
        durationSec: 2520,
        source: "APPLE_HEALTH",
        externalId: hashSampleKey(
          "HKWorkoutActivityTypeCycling",
          "42",
          "a",
          "b",
        ),
        metadata: { activityType: "HKWorkoutActivityTypeCycling" },
      },
    });
    const other = (await makeUser()).id;
    await prisma.workout.create({
      data: {
        userId: other,
        sportType: "running",
        startedAt: START,
        endedAt: END,
        durationSec: 2520,
        source: "APPLE_HEALTH",
        externalId: hashSampleKey(RUN, "42", "x", "y"),
        metadata: { activityType: RUN },
      },
    });

    await applyMigration();

    const rows = await workouts();
    expect(rows.map((r) => r.id).sort()).toEqual([oldest, ride.id].sort());
    const kept = rows.find((r) => r.id === oldest)!;
    expect(kept.externalId).toBe(workoutExternalId(RUN, START, END));
    expect(kept.totalEnergyKcal).toBe(410);
    expect(
      await prisma.workoutRoute.findUnique({ where: { workoutId: oldest } }),
    ).not.toBeNull();
    expect(
      await prisma.workoutSamples.findUnique({ where: { workoutId: oldest } }),
    ).not.toBeNull();
    const moved = await prisma.personalRecord.findUniqueOrThrow({
      where: { id: record.id },
    });
    expect(moved.externalId).toBe(kept.externalId);
    expect(await prisma.workout.count({ where: { userId: other } })).toBe(1);

    // A second application changes nothing.
    const before = await workouts();
    await applyMigration();
    expect(await workouts()).toEqual(before);

    // And the next export finds the row.
    const s = SPELLINGS[2];
    const result = await importExport(
      `<Workout workoutActivityType="${RUN}" duration="${s.duration}" durationUnit="min" startDate="${s.start}" endDate="${s.end}"/>`,
    );
    expect(result.workouts).toMatchObject({ inserted: 0, updated: 1 });
    expect(
      await prisma.workout.count({ where: { userId, sportType: "running" } }),
    ).toBe(1);
  });

  it("leaves a workout stored without its activity type for the importer to recognise", async () => {
    const s = SPELLINGS[0];
    const legacy = hashSampleKey(RUN, s.duration, s.start, s.end);
    await prisma.workout.create({
      data: {
        userId,
        sportType: "running",
        startedAt: START,
        endedAt: END,
        durationSec: 2520,
        source: "APPLE_HEALTH",
        externalId: legacy,
      },
    });
    await applyMigration();
    expect((await workouts())[0].externalId).toBe(legacy);

    const result = await importExport(
      `<Workout workoutActivityType="${RUN}" duration="${s.duration}" durationUnit="min" startDate="${s.start}" endDate="${s.end}"/>`,
    );
    expect(result.workouts).toMatchObject({ inserted: 0, updated: 1 });
    const rows = await workouts();
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(workoutExternalId(RUN, START, END));
  });
});
