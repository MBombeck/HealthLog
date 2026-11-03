/**
 * Migration 0412: an update of `measurements` that changes nothing keeps its
 * stamps and stays on its page.
 *
 * `updated_at` sits in the sync-feed index, so an update that moved it could
 * never be heap-only, and every provider re-sync that rewrote unchanged rows
 * grew the table by a full row version and an entry in every index. Proven
 * here against Postgres: the no-op update keeps `updated_at` and
 * `sync_version` and is counted as HOT in the transaction's own statistics,
 * a real change still moves both, the nightly check reads the table's
 * statistics and leaves the vacuuming to autovacuum. The migration's lock
 * wait is proven through the real `migrate deploy` in
 * `migrate-deploy-lock-retry.test.ts`.
 */
import { Client } from "pg";
import { beforeEach, describe, expect, it } from "vitest";

import {
  resolveSteps,
  runMeasurementMaintenance,
  tableHealth,
} from "@/lib/jobs/measurement-maintenance";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();

async function seedReading() {
  const user = await prisma.user.create({
    data: {
      username: "hot-update",
      email: "hot-update@example.test",
      role: "USER",
      timezone: "UTC",
    },
  });
  return prisma.measurement.create({
    data: {
      userId: user.id,
      type: "WEIGHT",
      value: 72.3,
      unit: "kg",
      measuredAt: new Date("2026-10-01T07:00:00.000Z"),
      source: "WITHINGS",
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

describe("an update that changes nothing", () => {
  it("keeps updated_at and sync_version and stays on its page", async () => {
    const row = await seedReading();
    await new Promise((r) => setTimeout(r, 20));

    // Read as a difference within the transaction. Since Postgres 15 the
    // `pg_stat_xact_*` views also carry counts an earlier transaction on the
    // same connection has not flushed yet (stats flush at most once a
    // second), so an update from the case before this one could show up.
    const hot = await prisma.$transaction(async (tx) => {
      const read = async () => {
        const [stats] = await tx.$queryRaw<Array<{ hot: bigint; upd: bigint }>>`
          SELECT n_tup_hot_upd AS hot, n_tup_upd AS upd
          FROM pg_stat_xact_user_tables WHERE relname = 'measurements'`;
        return { hot: Number(stats?.hot ?? 0), upd: Number(stats?.upd ?? 0) };
      };
      const before = await read();
      await tx.measurement.update({
        where: { id: row.id },
        data: { value: 72.3, deletedAt: null, syncVersion: { increment: 1 } },
      });
      const after = await read();
      return { hot: after.hot - before.hot, upd: after.upd - before.upd };
    });
    expect(hot.upd).toBe(1);
    expect(hot.hot).toBe(1);

    const after = await prisma.measurement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.updatedAt.getTime()).toBe(row.updatedAt.getTime());
    expect(after.syncVersion).toBe(row.syncVersion);
  });

  it("still moves both stamps when a value changes", async () => {
    const row = await seedReading();
    await new Promise((r) => setTimeout(r, 20));
    await prisma.measurement.update({
      where: { id: row.id },
      data: { value: 72.4, syncVersion: { increment: 1 } },
    });
    const after = await prisma.measurement.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.updatedAt.getTime()).toBeGreaterThan(row.updatedAt.getTime());
    expect(after.syncVersion).toBe(row.syncVersion + 1);
  });

  it("gives the table room on each page and an earlier autovacuum", async () => {
    const [rel] = await prisma.$queryRaw<Array<{ options: string[] | null }>>`
      SELECT reloptions AS options FROM pg_class WHERE relname = 'measurements'`;
    expect(rel.options).toEqual(
      expect.arrayContaining([
        "fillfactor=85",
        "autovacuum_vacuum_scale_factor=0.05",
      ]),
    );
  });
});

describe("the nightly check", () => {
  it("reads the statistics and leaves the vacuuming to autovacuum", async () => {
    await seedReading();
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
    try {
      await db.query("ANALYZE measurements");
      const health = await tableHealth(db);
      expect(health.heapBytes).toBeGreaterThan(0);
      const steps = resolveSteps({});
      expect(steps).toEqual({ vacuum: false, reindex: false });
      const summary = await runMeasurementMaintenance(db, steps);
      expect(summary.outcome).toBe("nothing_due");
      expect(summary.steps).toEqual([]);
    } finally {
      await db.end();
    }
  });
});
