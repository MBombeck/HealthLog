/**
 * Migration 0557 stamps a tombstone written before 0546 as Apple Health's
 * deletion only where the audit trail proves it: the tombstone lies in the
 * window of one `<domain>.delete.by_external_ids` request, and that window
 * holds exactly as many unstamped Apple Health tombstones as the request
 * deleted. Everything else keeps reading as deleted in HealthLog, so its
 * re-post stays refused. Nothing but the origin column moves, and a rerun
 * changes nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { makeMeasurement, makeMedication, makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma",
    "migrations",
    "0557_tombstone_deletion_origin_backfill",
    "migration.sql",
  ),
  "utf8",
);

async function runMigration(): Promise<void> {
  const blocks = MIGRATION.match(/DO \$migration\$[\s\S]*?\$migration\$;/g);
  expect(blocks).toHaveLength(1);
  await prisma.$executeRawUnsafe(blocks![0]);
}

/** Well before 0546 ran in this database. */
const T = new Date("2026-06-01T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T.getTime() + offsetMs);

async function auditDelete(
  userId: string,
  action: string,
  deleted: number,
  createdAt: Date,
) {
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      details: JSON.stringify({ processed: deleted, deleted }),
      createdAt,
    },
  });
}

/** Each reading at its own minute: the reading key is unique. */
let readings = 0;

async function tombstone(
  userId: string,
  externalId: string,
  deletedAt: Date,
  source: "APPLE_HEALTH" | "MANUAL" = "APPLE_HEALTH",
) {
  return makeMeasurement(
    { id: userId },
    {
      source,
      externalId,
      measuredAt: at(-86_400_000 + ++readings * 60_000),
      deletedAt,
      syncVersion: 3,
      updatedAt: deletedAt,
    },
  );
}

async function origin(id: string) {
  return prisma.measurement.findUniqueOrThrow({
    where: { id },
    select: {
      deletedAt: true,
      appleHealthDeletedAt: true,
      updatedAt: true,
      syncVersion: true,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("migration 0557 backfill", () => {
  it("stamps the tombstones one Apple Health delete request accounts for", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const a = await tombstone(user.id, "uuid-a", at(-800));
    const b = await tombstone(user.id, "uuid-b", at(-700));
    await auditDelete(user.id, "measurement.delete.by_external_ids", 2, T);

    await runMigration();

    for (const row of [a, b]) {
      const after = await origin(row.id);
      expect(after.appleHealthDeletedAt?.getTime()).toBe(
        row.deletedAt!.getTime(),
      );
      // The sync feed does not see the backfill.
      expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
      expect(after.syncVersion).toBe(3);
    }

    // A rerun stamps nothing new and changes nothing.
    await runMigration();
    expect((await origin(a.id)).appleHealthDeletedAt?.getTime()).toBe(
      a.deletedAt!.getTime(),
    );
  });

  it("leaves a window whose count does not match as deleted in HealthLog", async () => {
    const user = await makeUser({ timezone: "UTC" });
    // The phone reported one deletion; the person deleted another Apple
    // Health reading in the same minute. Which is which is not provable.
    const reported = await tombstone(user.id, "uuid-c", at(-500));
    const byPerson = await tombstone(user.id, "uuid-d", at(-30_000));
    await auditDelete(user.id, "measurement.delete.by_external_ids", 1, T);

    await runMigration();

    expect((await origin(reported.id)).appleHealthDeletedAt).toBeNull();
    expect((await origin(byPerson.id)).appleHealthDeletedAt).toBeNull();
  });

  it("does not reach past the previous request, another account or another domain", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const other = await makeUser({ timezone: "UTC" });
    // A deletion the person made between two requests of the phone.
    const earlier = await tombstone(user.id, "uuid-e", at(-120_000));
    const between = await tombstone(user.id, "uuid-f", at(-30_000));
    const latest = await tombstone(user.id, "uuid-g", at(-200));
    await auditDelete(
      user.id,
      "measurement.delete.by_external_ids",
      1,
      at(-119_000),
    );
    await auditDelete(user.id, "measurement.delete.by_external_ids", 1, T);
    // Another account's request and another domain's request in the window.
    const foreign = await tombstone(other.id, "uuid-h", at(-300));
    await auditDelete(other.id, "mood.delete.by_external_ids", 1, T);
    // A hand-entered reading is never a by-external-ids candidate.
    const manual = await tombstone(user.id, "uuid-i", at(-100), "MANUAL");

    await runMigration();

    expect((await origin(earlier.id)).appleHealthDeletedAt).not.toBeNull();
    // The second window holds `between` and `latest`, one more than deleted.
    expect((await origin(between.id)).appleHealthDeletedAt).toBeNull();
    expect((await origin(latest.id)).appleHealthDeletedAt).toBeNull();
    expect((await origin(foreign.id)).appleHealthDeletedAt).toBeNull();
    expect((await origin(manual.id)).appleHealthDeletedAt).toBeNull();
  });

  it("ignores a request after 0546, whose deletes stamp the origin themselves", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const future = new Date(Date.now() + 86_400_000);
    const row = await tombstone(
      user.id,
      "uuid-j",
      new Date(future.getTime() - 500),
    );
    await auditDelete(user.id, "measurement.delete.by_external_ids", 1, future);

    await runMigration();

    expect((await origin(row.id)).appleHealthDeletedAt).toBeNull();
  });

  it("stamps an Apple Health dose and leaves a dose on a slot row the person deleted", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const medication = await makeMedication(user);
    const dose = (externalId: string, source: "APPLE_HEALTH" | "REMINDER") =>
      prisma.medicationIntakeEvent.create({
        data: {
          userId: user.id,
          medicationId: medication.id,
          scheduledFor: at(-86_400_000 + externalId.length * 3_600_000),
          takenAt: at(-86_400_000),
          source,
          externalId,
          deletedAt: at(-400),
        },
      });
    const reported = await dose("dose-a", "APPLE_HEALTH");
    // An Apple Health dose that had landed on a pre-minted slot row keeps the
    // row's source; the old delete never touched it, so it was the person's.
    const onSlot = await dose("dose-bb", "REMINDER");
    await auditDelete(
      user.id,
      "medication.intake.delete.by_external_ids",
      1,
      T,
    );

    await runMigration();

    const rows = await prisma.medicationIntakeEvent.findMany({
      where: { id: { in: [reported.id, onSlot.id] } },
      select: { id: true, appleHealthDeletedAt: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r.appleHealthDeletedAt]));
    expect(byId.get(reported.id)?.getTime()).toBe(at(-400).getTime());
    expect(byId.get(onSlot.id)).toBeNull();
  });
});
