/**
 * v1.28.33 — concurrency contract for the measurement-rollup persist
 * path (issue #486).
 *
 * A cumulative Apple Health `export.zip` re-import runs the end-of-import
 * full fold while the regular write hooks (iOS batch sync, dashboard
 * warm-up) keep firing their own per-day recomputes. Two writers on the
 * same `(userId, type, granularity, bucketStart, source)` partition used
 * to interleave delete-then-insert, and the losing INSERT tripped the
 * `measurement_rollups_pkey` composite primary key (Postgres 23505). The
 * previous shape swallowed the P2002 and DROPPED the loser's freshly
 * computed aggregate — which is exactly wrong when the loser saw newer
 * measurements than the winner: the bucket stayed stale until the next
 * unrelated write.
 *
 * The persist path now writes through `INSERT … ON CONFLICT … DO UPDATE`
 * so the later recompute overwrites with its freshly computed values
 * (last-write-wins) instead of raising or dropping. Pinned here against
 * the real Postgres:
 *
 *   1. **Racing peer holds the partition uncommitted.** A peer
 *      transaction inserts a stale aggregate for the bucket and holds
 *      its transaction open; the real write-hook recompute (which sees
 *      one more measurement) runs concurrently and blocks on the PK.
 *      When the peer commits, the hook's fresher aggregate must land —
 *      not vanish into a swallowed unique violation.
 *
 *   2. **Two full user folds racing.** `recomputeUserRollups` twice in
 *      parallel neither throws nor duplicates rows.
 *
 *   3. **N-way write-hook fan-out.** Concurrent
 *      `recomputeBucketsForMeasurement` calls for the same day all
 *      resolve and converge on the correct aggregate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  recomputeBucketsForMeasurement,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";

// No pg-boss in the integration harness — the WEEK/MONTH/YEAR enqueue
// inside the write hook is a silent no-op when no boss is attached.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

/**
 * Poll `pg_stat_activity` until some backend is lock-waiting on a
 * `measurement_rollups` statement (the hook's upsert queued behind the
 * peer's uncommitted insert). Bounded so a scheduling hiccup degrades to
 * a plain sleep rather than a hang.
 */
async function waitForRollupLockWaiter(timeoutMs = 5_000): Promise<boolean> {
  const prisma = getPrismaClient();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND datname = current_database()
        AND query ILIKE '%measurement_rollups%'
    `;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("measurement rollups — concurrent recompute (issue #486)", () => {
  it("a recompute racing a committed peer write keeps the fresher aggregate", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-race-user",
        email: "rollup-race-user@example.test",
        role: "USER",
      },
    });
    const dayStart = new Date("2026-04-22T00:00:00.000Z");
    const m1At = new Date("2026-04-22T07:00:00.000Z");
    const m2At = new Date("2026-04-22T19:00:00.000Z");

    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "APPLE_HEALTH",
        measuredAt: m1At,
      },
    });

    // Peer transaction: mimics the end-of-import fold writing the bucket
    // from an aggregate snapshot taken BEFORE the second measurement
    // landed (count 1, mean 80). It holds its transaction open so the
    // real write hook below queues behind the uncommitted PK row —
    // the exact interleaving the reporter's Postgres log shows.
    let releasePeer!: () => void;
    const gate = new Promise<void>((r) => {
      releasePeer = r;
    });
    let peerInserted!: () => void;
    const peerReady = new Promise<void>((r) => {
      peerInserted = r;
    });
    const peer = prisma.$transaction(
      async (tx) => {
        await tx.measurementRollup.deleteMany({
          where: {
            userId: user.id,
            type: "WEIGHT",
            granularity: "DAY",
            bucketStart: dayStart,
          },
        });
        await tx.measurementRollup.createMany({
          data: [
            {
              userId: user.id,
              type: "WEIGHT",
              granularity: "DAY",
              bucketStart: dayStart,
              source: "APPLE_HEALTH",
              count: 1,
              mean: 80,
              minValue: 80,
              maxValue: 80,
              sumValue: 80,
              sd: 0,
              slope: null,
              r2: null,
              computedAt: new Date(),
            },
          ],
        });
        peerInserted();
        await gate;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    await peerReady;

    // Second measurement lands (committed) — the write hook's aggregate
    // sees BOTH rows: count 2, mean 90.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 100,
        unit: "kg",
        source: "APPLE_HEALTH",
        measuredAt: m2At,
      },
    });

    const hook = recomputeBucketsForMeasurement(user.id, "WEIGHT", m1At);

    // Let the hook's persist reach the PK wait behind the peer's
    // uncommitted row, then commit the peer with its STALE aggregate.
    await waitForRollupLockWaiter();
    releasePeer();
    await peer;
    await hook;

    const row = await prisma.measurementRollup.findUnique({
      where: {
        userId_type_granularity_bucketStart_source: {
          userId: user.id,
          type: "WEIGHT",
          granularity: "DAY",
          bucketStart: dayStart,
          source: "APPLE_HEALTH",
        },
      },
    });
    // The hook computed from the full day (both measurements). Its
    // recompute must survive the race — a swallowed unique violation
    // would leave the peer's stale count-1 / mean-80 aggregate behind.
    expect(row).not.toBeNull();
    expect(row!.count).toBe(2);
    expect(row!.mean).toBeCloseTo(90, 6);
    expect(row!.minValue).toBeCloseTo(80, 6);
    expect(row!.maxValue).toBeCloseTo(100, 6);
    expect(row!.sumValue).toBeCloseTo(180, 6);
  });

  it("two full user folds racing neither throw nor duplicate rows", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-fold-race-user",
        email: "rollup-fold-race-user@example.test",
        role: "USER",
      },
    });
    const days = 30;
    const data = Array.from({ length: days }, (_, i) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      value: 80 + (i % 5),
      unit: "kg",
      source: "APPLE_HEALTH" as const,
      measuredAt: new Date(Date.UTC(2026, 3, 1 + i, 8, 0, 0)),
    }));
    await prisma.measurement.createMany({ data });

    const window = {
      from: new Date("2026-03-31T00:00:00.000Z"),
      to: new Date("2026-05-02T00:00:00.000Z"),
    };
    // The end-of-import fold racing the boot backfill for the same user.
    await expect(
      Promise.all([
        recomputeUserRollups(user.id, window),
        recomputeUserRollups(user.id, window),
      ]),
    ).resolves.toBeDefined();

    const rows = await prisma.measurementRollup.findMany({
      where: { userId: user.id, type: "WEIGHT", granularity: "DAY" },
    });
    expect(rows).toHaveLength(days);
    for (const row of rows) {
      expect(row.count).toBe(1);
    }
  });

  it("N concurrent write-hook recomputes for the same day all resolve", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-fanout-user",
        email: "rollup-fanout-user@example.test",
        role: "USER",
      },
    });
    const measuredAt = new Date("2026-04-22T12:00:00.000Z");
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-04-22T07:00:00.000Z"),
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 84,
          unit: "kg",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-04-22T20:00:00.000Z"),
        },
      ],
    });

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          recomputeBucketsForMeasurement(user.id, "WEIGHT", measuredAt),
        ),
      ),
    ).resolves.toBeDefined();

    const row = await prisma.measurementRollup.findUnique({
      where: {
        userId_type_granularity_bucketStart_source: {
          userId: user.id,
          type: "WEIGHT",
          granularity: "DAY",
          bucketStart: new Date("2026-04-22T00:00:00.000Z"),
          source: "APPLE_HEALTH",
        },
      },
    });
    expect(row).not.toBeNull();
    expect(row!.count).toBe(2);
    expect(row!.mean).toBeCloseTo(82, 6);
  });
});
