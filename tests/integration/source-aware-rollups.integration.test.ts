/**
 * v1.11.1 — source-aware measurement rollups, DB round-trip.
 *
 * The rollup grain gained `source` in its primary key
 * (`@@id([userId, type, granularity, bucketStart, source])`): the populator
 * now mints ONE row per (type, day, source) instead of one source-blind
 * aggregate per (type, day). The read path
 * (`readRollupBuckets` → `collapseRollupRowsBySource`) collapses the
 * overlapping per-source rows back to ONE row per bucket using the user's
 * source-priority ladder before the linear DAY-bucket composition runs.
 *
 * `collapseRollupRowsBySource` is unit-tested in isolation
 * (`src/lib/rollups/__tests__/collapse-rollup-rows-by-source.test.ts`); this
 * suite pins the same contract end-to-end through the real Postgres
 * testcontainer — the populator SQL groups by `m."source"` and the reader
 * lazy-loads the user's ladder from `sourcePriorityJson`. Five contracts:
 *
 *   1. **Point-metric ladder pick.** RHR with WHOOP + APPLE_HEALTH on one
 *      day → two raw rows, one collapsed row that surfaces the WHOOP value
 *      (WHOOP leads the restingHeartRate ladder).
 *   2. **Cumulative no-blend.** ACTIVITY_STEPS with APPLE_HEALTH + WITHINGS
 *      on one day → two raw rows, one collapsed row reflecting ONLY the
 *      Apple canonical source's count/mean — never the cross-source sum.
 *   3. **Native-vs-derived.** RECOVERY_SCORE with WHOOP + COMPUTED → the
 *      WHOOP (device-native) row wins over the COMPUTED proxy.
 *   4. **Disappearing source.** Soft-deleting the WHOOP RHR rows and
 *      recomputing drops the stale WHOOP rollup row (delete-then-insert),
 *      leaving the APPLE row alone — the reader now surfaces the Apple value.
 *   5. **Idempotency.** Re-running the recompute on a dual-source day keeps
 *      the per-source row count at two (no duplicate-per-source rows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  recomputeUserRollups,
  readRollupBuckets,
} from "@/lib/rollups/measurement-rollups";

// `recomputeBucketsForMeasurement` enqueues WEEK/MONTH/YEAR jobs via pg-boss;
// the DAY-only `recomputeUserRollups` calls here never touch the queue, but the
// sibling rollups test mocks the boss instance and the integration suite runs
// with `isolate: false`, so we leave it detached (null) for parity.
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

// Deterministic UTC day used across every case. All seeded `measuredAt`
// values land inside this calendar day so each (type, source) folds to a
// single DAY bucket.
const DAY = "2026-05-20";
const DAY_START_UTC = new Date(`${DAY}T00:00:00.000Z`);
const DAY_END_UTC = new Date(`${DAY}T23:59:59.999Z`);
// Read window [from, to) that brackets the seeded day with room to spare.
const FROM = new Date(`${DAY}T00:00:00.000Z`);
const TO = new Date("2026-05-21T00:00:00.000Z");

let seq = 0;
async function seedUser(prisma: ReturnType<typeof getPrismaClient>) {
  seq += 1;
  return prisma.user.create({
    data: {
      username: `source-aware-rollup-${seq}`,
      email: `source-aware-rollup-${seq}@example.test`,
      role: "USER",
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("source-aware measurement rollups — integration (v1.11.1)", () => {
  it("RESTING_HEART_RATE: keeps one raw row per source, collapses to the WHOOP ladder pick", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 51,
          unit: "bpm",
          source: "WHOOP",
          measuredAt: new Date(`${DAY}T06:00:00.000Z`),
        },
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 54,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date(`${DAY}T07:00:00.000Z`),
        },
      ],
    });

    await recomputeUserRollups(user.id, {
      types: ["RESTING_HEART_RATE"],
      granularities: ["DAY"],
    });

    // Raw table: one row PER source for the (type, day).
    const rawRows = await prisma.measurementRollup.findMany({
      where: {
        userId: user.id,
        type: "RESTING_HEART_RATE",
        granularity: "DAY",
        bucketStart: { gte: DAY_START_UTC, lte: DAY_END_UTC },
      },
      orderBy: { source: "asc" },
    });
    expect(rawRows).toHaveLength(2);
    expect(rawRows.map((r) => r.source).sort()).toEqual([
      "APPLE_HEALTH",
      "WHOOP",
    ]);
    // Each per-source row carries that source's single reading.
    const apple = rawRows.find((r) => r.source === "APPLE_HEALTH")!;
    const whoop = rawRows.find((r) => r.source === "WHOOP")!;
    expect(apple.count).toBe(1);
    expect(apple.mean).toBeCloseTo(54, 5);
    expect(whoop.count).toBe(1);
    expect(whoop.mean).toBeCloseTo(51, 5);

    // Read path collapses to ONE bucket — WHOOP wins the restingHeartRate
    // ladder (WHOOP > APPLE_HEALTH > WITHINGS).
    const buckets = await readRollupBuckets(
      user.id,
      "RESTING_HEART_RATE",
      "DAY",
      FROM,
      TO,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].mean).toBeCloseTo(51, 5);
    expect(buckets[0].count).toBe(1);
  });

  it("ACTIVITY_STEPS: collapses to the Apple canonical source only — never a cross-source 7800 blend", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "ACTIVITY_STEPS",
          value: 4000,
          unit: "count",
          source: "APPLE_HEALTH",
          measuredAt: new Date(`${DAY}T08:00:00.000Z`),
        },
        {
          userId: user.id,
          type: "ACTIVITY_STEPS",
          value: 3800,
          unit: "count",
          source: "WITHINGS",
          measuredAt: new Date(`${DAY}T09:00:00.000Z`),
        },
      ],
    });

    await recomputeUserRollups(user.id, {
      types: ["ACTIVITY_STEPS"],
      granularities: ["DAY"],
    });

    const rawRows = await prisma.measurementRollup.findMany({
      where: {
        userId: user.id,
        type: "ACTIVITY_STEPS",
        granularity: "DAY",
        bucketStart: { gte: DAY_START_UTC, lte: DAY_END_UTC },
      },
      orderBy: { source: "asc" },
    });
    expect(rawRows).toHaveLength(2);
    const apple = rawRows.find((r) => r.source === "APPLE_HEALTH")!;
    const withings = rawRows.find((r) => r.source === "WITHINGS")!;
    expect(apple.mean).toBeCloseTo(4000, 5);
    expect(apple.sumValue).toBeCloseTo(4000, 5);
    expect(withings.mean).toBeCloseTo(3800, 5);

    // Steps ladder = APPLE_HEALTH > WITHINGS > MANUAL. The collapsed bucket
    // reflects ONLY the Apple row — a single canonical source's daily total,
    // not the 7800 cross-source sum that a source-blind aggregate produced.
    const buckets = await readRollupBuckets(
      user.id,
      "ACTIVITY_STEPS",
      "DAY",
      FROM,
      TO,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].count).toBe(1); // one Apple reading, not two summed
    expect(buckets[0].mean).toBeCloseTo(4000, 5);
    expect(buckets[0].mean).not.toBeCloseTo(7800, 5);
    expect(buckets[0].mean).not.toBeCloseTo(3900, 5); // not a cross-source avg
  });

  it("RECOVERY_SCORE: native WHOOP wins over the COMPUTED proxy", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "RECOVERY_SCORE",
          value: 70,
          unit: "score",
          source: "WHOOP",
          measuredAt: new Date(`${DAY}T05:00:00.000Z`),
        },
        {
          userId: user.id,
          type: "RECOVERY_SCORE",
          value: 62,
          unit: "score",
          source: "COMPUTED",
          measuredAt: new Date(`${DAY}T05:30:00.000Z`),
        },
      ],
    });

    await recomputeUserRollups(user.id, {
      types: ["RECOVERY_SCORE"],
      granularities: ["DAY"],
    });

    const rawRows = await prisma.measurementRollup.findMany({
      where: {
        userId: user.id,
        type: "RECOVERY_SCORE",
        granularity: "DAY",
        bucketStart: { gte: DAY_START_UTC, lte: DAY_END_UTC },
      },
    });
    expect(rawRows).toHaveLength(2);

    // recovery ladder = WHOOP > COMPUTED — the device-native score wins.
    const buckets = await readRollupBuckets(
      user.id,
      "RECOVERY_SCORE",
      "DAY",
      FROM,
      TO,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].mean).toBeCloseTo(70, 5);
  });

  it("disappearing source: soft-deleting WHOOP rows drops the stale WHOOP rollup row on recompute", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 51,
          unit: "bpm",
          source: "WHOOP",
          measuredAt: new Date(`${DAY}T06:00:00.000Z`),
        },
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 54,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date(`${DAY}T07:00:00.000Z`),
        },
      ],
    });

    await recomputeUserRollups(user.id, {
      types: ["RESTING_HEART_RATE"],
      granularities: ["DAY"],
    });

    // Both sources present after the first fold.
    const firstFold = await prisma.measurementRollup.findMany({
      where: {
        userId: user.id,
        type: "RESTING_HEART_RATE",
        granularity: "DAY",
        bucketStart: { gte: DAY_START_UTC, lte: DAY_END_UTC },
      },
    });
    expect(firstFold).toHaveLength(2);

    // The WHOOP source disappears (user disconnected the strap / deleted the
    // last reading from that device). Tombstone the WHOOP rows.
    await prisma.measurement.updateMany({
      where: { userId: user.id, source: "WHOOP" },
      data: { deletedAt: new Date() },
    });

    // Re-fold the same day. The populator delete-then-inserts the affected
    // (type, bucket) partition across ALL sources, so the now-empty WHOOP
    // bucket is dropped rather than stranded as a stale row a plain upsert
    // would never revisit.
    await recomputeUserRollups(user.id, {
      types: ["RESTING_HEART_RATE"],
      granularities: ["DAY"],
    });

    const secondFold = await prisma.measurementRollup.findMany({
      where: {
        userId: user.id,
        type: "RESTING_HEART_RATE",
        granularity: "DAY",
        bucketStart: { gte: DAY_START_UTC, lte: DAY_END_UTC },
      },
    });
    expect(secondFold).toHaveLength(1);
    expect(secondFold[0].source).toBe("APPLE_HEALTH");

    // The reader now surfaces the Apple value — WHOOP is gone from the ladder
    // resolution because it no longer has a row.
    const buckets = await readRollupBuckets(
      user.id,
      "RESTING_HEART_RATE",
      "DAY",
      FROM,
      TO,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].mean).toBeCloseTo(54, 5);
  });

  it("idempotency: re-running the recompute keeps the per-source row count at two", async () => {
    const prisma = getPrismaClient();
    const user = await seedUser(prisma);

    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 51,
          unit: "bpm",
          source: "WHOOP",
          measuredAt: new Date(`${DAY}T06:00:00.000Z`),
        },
        {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          value: 54,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date(`${DAY}T07:00:00.000Z`),
        },
      ],
    });

    const countRows = () =>
      prisma.measurementRollup.count({
        where: {
          userId: user.id,
          type: "RESTING_HEART_RATE",
          granularity: "DAY",
          bucketStart: { gte: DAY_START_UTC, lte: DAY_END_UTC },
        },
      });

    await recomputeUserRollups(user.id, {
      types: ["RESTING_HEART_RATE"],
      granularities: ["DAY"],
    });
    expect(await countRows()).toBe(2);

    // Second pass over the identical fixture must not duplicate per-source
    // rows — the delete-then-insert keys on (userId, type, granularity,
    // bucketStart, source).
    await recomputeUserRollups(user.id, {
      types: ["RESTING_HEART_RATE"],
      granularities: ["DAY"],
    });
    expect(await countRows()).toBe(2);

    // And the collapsed read is still a single WHOOP-canonical bucket.
    const buckets = await readRollupBuckets(
      user.id,
      "RESTING_HEART_RATE",
      "DAY",
      FROM,
      TO,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].mean).toBeCloseTo(51, 5);
  });
});
