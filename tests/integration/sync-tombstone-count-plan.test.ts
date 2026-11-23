/**
 * The sync handshake's tombstone count reads the caller's own tombstones only.
 *
 * `GET /api/sync/state` counts the account's soft-deleted measurements on
 * every iOS handshake. Read through the instance-wide tombstone index, that
 * count walked every account's tombstones (75 days of them, every sweep and
 * consolidation of every account) to answer for one. With the partial
 * `(user_id, deleted_at) WHERE deleted_at IS NOT NULL` index the count is an
 * index read of this account's tombstones and nothing else.
 *
 * That holds on a table with statistics, which is every table autovacuum has
 * seen. Without them the planner prices `deleted_at IS NOT NULL` at its
 * default selectivity, which makes the partial index look as large as the
 * account indexes, and which of them it reads is a tie it breaks by build
 * details. Either way the read stays inside the caller's own rows, which is
 * what that case pins.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { countTombstonedMeasurements } from "@/lib/sync/measurement-counts";

import { getPrismaClient, truncateAllTables } from "./setup";
import { explainStatements } from "./statement-plans";

const prisma = () => getPrismaClient();

beforeEach(async () => {
  await truncateAllTables(prisma());
  // Statistics another file in this worker gathered survive its TRUNCATE and
  // would decide the plan for this fixture; each case states its own.
  await prisma().$executeRawUnsafe(
    "ALTER TABLE measurements SET (autovacuum_enabled = false)",
  );
  await prisma().$executeRawUnsafe(
    "DELETE FROM pg_statistic WHERE starelid = 'measurements'::regclass",
  );
});

afterAll(async () => {
  await prisma().$executeRawUnsafe(
    "ALTER TABLE measurements RESET (autovacuum_enabled)",
  );
});

async function account(id: string, live: number, tombstones: number) {
  await prisma().user.create({
    data: { id, username: id, email: `${id}@example.test` },
  });
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1) + i * 60_000);
  await prisma().measurement.createMany({
    data: Array.from({ length: live + tombstones }, (_, i) => ({
      userId: id,
      type: "PULSE" as const,
      value: 60 + (i % 40),
      unit: "bpm",
      measuredAt: at(i),
      deletedAt: i < tombstones ? new Date(Date.UTC(2026, 10, 1)) : null,
    })),
  });
}

describe("the tombstone count of the sync handshake", () => {
  it("is exact and visits only the caller's tombstones, with statistics", async () => {
    await account("caller", 50, 7);
    await account("neighbour", 50, 400);
    await prisma().$executeRawUnsafe("ANALYZE measurements");

    const ledger = await explainStatements(() =>
      countTombstonedMeasurements("caller"),
    );

    expect(ledger.result).toBe(7);
    expect(ledger.plans.some((p) => p.seqScan)).toBe(false);
    // The caller's seven, not the neighbour's four hundred.
    expect(ledger.rowVisits).toBeLessThanOrEqual(7);
    expect(JSON.stringify(ledger.plans.map((p) => p.plan))).toContain(
      "measurements_user_id_deleted_at_tombstone_idx",
    );
  });

  it("is exact and stays inside the caller's rows, without statistics", async () => {
    await account("caller", 50, 7);
    await account("neighbour", 50, 400);
    const [stats] = await prisma().$queryRawUnsafe<Array<{ columns: number }>>(
      `SELECT COUNT(*)::int AS columns FROM pg_statistic
        WHERE starelid = 'measurements'::regclass`,
    );
    expect(stats).toEqual({ columns: 0 });

    const ledger = await explainStatements(() =>
      countTombstonedMeasurements("caller"),
    );

    expect(ledger.result).toBe(7);
    expect(ledger.plans.some((p) => p.seqScan)).toBe(false);
    // At most the caller's 57 rows; never one of the neighbour's 450.
    expect(ledger.rowVisits).toBeLessThanOrEqual(57);
  });
});
