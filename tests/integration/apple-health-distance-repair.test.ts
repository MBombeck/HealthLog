/**
 * Integration coverage for the export-import walking-distance repair
 * (issue #944).
 *
 * The defect stored every archive-imported `WALKING_RUNNING_DISTANCE` row a
 * thousand times too small. `src/lib/measurements/repair-apple-health-distance.ts`
 * heals what is already in the database, and everything that matters about it
 * is a database property: which rows the criterion actually selects, that the
 * multiply lands in one transaction with its audit row, and that a second run
 * finds nothing. None of that can be proven against a mock, so this runs
 * against the testcontainer Postgres (Docker / OrbStack; `pnpm test:integration`).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  APPLE_HEALTH_DISTANCE_REPAIR_ACTION,
  applyAppleHealthDistanceRepair,
  planAppleHealthDistanceRepair,
} from "@/lib/measurements/repair-apple-health-distance";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";
import type {
  MeasurementAggregationProvenance,
  MeasurementSource,
  MeasurementType,
  PrismaClient,
} from "@/generated/prisma/client";

const DISTANCE_PREFIX = "stats:HKQuantityTypeIdentifierDistanceWalkingRunning:";

let dayCounter = 0;

async function seedRow(
  prisma: PrismaClient,
  userId: string,
  overrides: {
    value: number;
    type?: MeasurementType;
    source?: MeasurementSource;
    provenance?: MeasurementAggregationProvenance | null;
    externalId?: string;
  },
): Promise<string> {
  dayCounter += 1;
  const measuredAt = new Date(Date.UTC(2026, 0, dayCounter, 12, 0, 0));
  const day = measuredAt.toISOString().slice(0, 10);
  const row = await prisma.measurement.create({
    data: {
      userId,
      type: overrides.type ?? "WALKING_RUNNING_DISTANCE",
      value: overrides.value,
      unit: "m",
      source: overrides.source ?? "APPLE_HEALTH",
      measuredAt,
      externalId: overrides.externalId ?? `${DISTANCE_PREFIX}${day}`,
      aggregationProvenance:
        overrides.provenance === undefined
          ? "EXPORT_XML_SOURCE_MAX"
          : overrides.provenance,
    },
    select: { id: true },
  });
  return row.id;
}

async function readRow(prisma: PrismaClient, id: string) {
  return prisma.measurement.findUniqueOrThrow({
    where: { id },
    select: { value: true, unit: true, syncVersion: true },
  });
}

async function makeUser(prisma: PrismaClient, tag: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      username: `distance-repair-${tag}`,
      email: `distance-repair-${tag}@example.test`,
      role: "USER",
    },
  });
  return user.id;
}

describe("Apple Health export distance repair — integration", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
    dayCounter = 0;
  });

  it("selects only rows the archive importer stamped, and repairs them once", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser(prisma, "km");

    const kmDay = await seedRow(prisma, userId, { value: 2.484 });
    const otherDay = await seedRow(prisma, userId, { value: 7.02 });
    // Decoys, one per arm of the criterion.
    const nativeStats = await seedRow(prisma, userId, {
      value: 8123,
      provenance: "HEALTHKIT_STATISTICS",
    });
    const legacyProvenance = await seedRow(prisma, userId, {
      value: 3.4,
      provenance: null,
    });
    const manualRow = await seedRow(prisma, userId, {
      value: 4.1,
      source: "MANUAL",
    });
    const otherType = await seedRow(prisma, userId, {
      value: 9000,
      type: "ACTIVITY_STEPS",
      externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-01-09",
    });
    const perSample = await seedRow(prisma, userId, {
      value: 1.2,
      externalId: "sample:abc123",
    });

    const plans = await planAppleHealthDistanceRepair(prisma, {
      archiveUnit: "km",
    });
    expect(plans).toHaveLength(1);
    expect(plans[0].userId).toBe(userId);
    expect(plans[0].repairable.map((row) => row.id).sort()).toEqual(
      [kmDay, otherDay].sort(),
    );
    expect(plans[0].alreadyRepairedAt).toBeNull();

    const outcome = await applyAppleHealthDistanceRepair(prisma, plans[0], {
      archiveUnit: "km",
    });
    await settleBackgroundTasks();
    expect(outcome).toMatchObject({ userId, updated: 2, skipped: 0 });

    expect((await readRow(prisma, kmDay)).value).toBeCloseTo(2484, 6);
    expect((await readRow(prisma, otherDay)).value).toBeCloseTo(7020, 6);
    // The delta feed pages on sync_version / updated_at, so a repaired row
    // has to look mutated to a paired client.
    expect((await readRow(prisma, kmDay)).syncVersion).toBe(2);
    expect((await readRow(prisma, kmDay)).unit).toBe("m");

    // Every decoy untouched.
    expect((await readRow(prisma, nativeStats)).value).toBe(8123);
    expect((await readRow(prisma, legacyProvenance)).value).toBe(3.4);
    expect((await readRow(prisma, manualRow)).value).toBe(4.1);
    expect((await readRow(prisma, otherType)).value).toBe(9000);
    expect((await readRow(prisma, perSample)).value).toBe(1.2);

    const audit = await prisma.auditLog.findMany({
      where: { action: APPLE_HEALTH_DISTANCE_REPAIR_ACTION, userId },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details ?? "{}")).toMatchObject({
      archiveUnit: "km",
      factor: 1000,
      rows: 2,
      issue: 944,
    });
  });

  it("is idempotent — a second run finds nothing to repair", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser(prisma, "twice");
    const rowId = await seedRow(prisma, userId, { value: 2.484 });

    const first = await planAppleHealthDistanceRepair(prisma, {
      archiveUnit: "km",
    });
    await applyAppleHealthDistanceRepair(prisma, first[0], {
      archiveUnit: "km",
    });
    await settleBackgroundTasks();

    const second = await planAppleHealthDistanceRepair(prisma, {
      archiveUnit: "km",
    });
    expect(second).toHaveLength(1);
    expect(second[0].repairable).toHaveLength(0);
    expect(second[0].candidateCount).toBe(1);
    expect(second[0].alreadyRepairedAt).toBeInstanceOf(Date);

    const outcome = await applyAppleHealthDistanceRepair(prisma, second[0], {
      archiveUnit: "km",
    });
    expect(outcome.updated).toBe(0);
    expect((await readRow(prisma, rowId)).value).toBeCloseTo(2484, 6);
    expect((await readRow(prisma, rowId)).syncVersion).toBe(2);
  });

  it("uses the archive's own unit and never writes an implausible value", async () => {
    const prisma = getPrismaClient();
    const userId = await makeUser(prisma, "mi");
    const mile = await seedRow(prisma, userId, { value: 1.543 });
    const absurd = await seedRow(prisma, userId, { value: 250 });

    const plans = await planAppleHealthDistanceRepair(prisma, {
      archiveUnit: "mi",
    });
    expect(plans[0].repairable.map((row) => row.id)).toEqual([mile]);
    expect(plans[0].outOfRange.map((row) => row.id)).toEqual([absurd]);

    const outcome = await applyAppleHealthDistanceRepair(prisma, plans[0], {
      archiveUnit: "mi",
    });
    await settleBackgroundTasks();
    expect(outcome).toMatchObject({ updated: 1, skipped: 1 });
    expect((await readRow(prisma, mile)).value).toBeCloseTo(2483.217792, 6);
    expect((await readRow(prisma, absurd)).value).toBe(250);
  });

  it("plans one entry per account", async () => {
    const prisma = getPrismaClient();
    const first = await makeUser(prisma, "a");
    const second = await makeUser(prisma, "b");
    await seedRow(prisma, first, { value: 1.5 });
    await seedRow(prisma, second, { value: 2.5 });
    await seedRow(prisma, second, { value: 3.5 });

    const plans = await planAppleHealthDistanceRepair(prisma, {
      archiveUnit: "km",
    });
    expect(
      plans.map((plan) => [plan.userId, plan.repairable.length]).sort(),
    ).toEqual(
      [
        [first, 1],
        [second, 2],
      ].sort(),
    );
  });
});
