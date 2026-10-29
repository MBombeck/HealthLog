/**
 * The full backfill against Postgres (#1298).
 *
 *   - The windowed fold (`foldUserRollupHistory`, a UTC calendar year per
 *     pass, newest first) writes exactly the rollup rows one pass of
 *     `recomputeUserRollups` over the whole five-year window writes: every
 *     granularity, every source, a week across New Year, the YEAR bucket the
 *     window's oldest edge snaps out to, and a reading older than the window.
 *   - A fold stopped part way and resumed with `before` ends in the same rows.
 *   - The boot discovery, rewritten to walk days instead of reading every
 *     reading in the window, finds the same accounts as the statement it
 *     replaced, kept verbatim below as the reference.
 */
import { PgBoss } from "pg-boss";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { Prisma, type MeasurementSource } from "@/generated/prisma/client";
import { activeAccountSql } from "@/lib/account-deletion/active-account";
import {
  enqueueBootTimeRollupBackfill,
  foldUserRollupHistory,
  isRollupFullBackfillPending,
  ROLLUP_FULL_BACKFILL_QUEUE,
  ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS,
} from "@/lib/rollups/full-backfill";
import {
  recomputeUserRollups,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";

import { makeUser } from "../kit/factories";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

import { getGlobalBoss } from "@/lib/jobs/boss-instance";

const prisma = getPrismaClient();
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

beforeEach(async () => {
  await truncateAllTables(prisma);
  vi.mocked(getGlobalBoss).mockReturnValue(null as never);
});

function utc(y: number, m: number, d: number, h = 12, min = 0): Date {
  return new Date(Date.UTC(y, m - 1, d, h, min));
}

/** Readings that can tell a windowed fold from one pass. */
async function seedHistory(userId: string): Promise<void> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const floor = new Date(now.getTime() - ROLLUP_FOLD_WINDOW_MS);
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  const add = (
    type: "WEIGHT" | "PULSE",
    source: MeasurementSource,
    at: Date,
    value: number,
  ) =>
    rows.push({
      userId,
      type,
      source,
      value,
      unit: type === "WEIGHT" ? "kg" : "bpm",
      measuredAt: at,
      externalId: `${source}:${type}:${at.toISOString()}`,
    });
  const days: Date[] = [];
  // A week across each of two New Years.
  for (let d = 0; d < 9; d++) {
    days.push(new Date(utc(year - 3, 12, 27).getTime() + d * DAY_MS));
    days.push(new Date(utc(year - 1, 12, 28).getTime() + d * DAY_MS));
  }
  days.push(utc(year - 2, 6, 15), utc(year - 2, 6, 16));
  days.push(new Date(now.getTime() - 3 * DAY_MS));
  // Just inside the window, and inside the YEAR bucket its edge snaps to.
  days.push(new Date(floor.getTime() + 2 * DAY_MS));
  days.push(new Date(floor.getTime() - 20 * DAY_MS));
  days.forEach((day, i) => {
    const base = Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
    );
    add("WEIGHT", "MANUAL", new Date(base + 7 * HOUR_MS), 80 + (i % 5) / 3);
    if (i % 2 === 0) {
      add("WEIGHT", "WITHINGS", new Date(base + 8 * HOUR_MS), 81 + i / 7);
    }
    for (let k = 0; k < 6; k++) {
      add(
        "PULSE",
        "APPLE_HEALTH",
        new Date(base + (k < 4 ? 9 : 15) * HOUR_MS + k * 7 * 60_000),
        55 + ((i * 7 + k * 11) % 40),
      );
    }
    add("PULSE", "GOOGLE_HEALTH", new Date(base + 23 * HOUR_MS), 60 + i);
  });
  await prisma.measurement.createMany({ data: rows });
}

async function snapshot(userId: string) {
  const rows = await prisma.measurementRollup.findMany({
    where: { userId },
    orderBy: [
      { type: "asc" },
      { granularity: "asc" },
      { bucketStart: "asc" },
      { source: "asc" },
    ],
  });
  return rows.map(({ computedAt, ...rest }) => {
    void computedAt;
    return rest;
  });
}

function expectSameRows(
  actual: Awaited<ReturnType<typeof snapshot>>,
  expected: Awaited<ReturnType<typeof snapshot>>,
): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((want, i) => {
    const got = actual[i] as Record<string, unknown>;
    for (const [key, value] of Object.entries(want)) {
      if (typeof value === "number" && key !== "count") {
        // A week across two windows is read in another range, so its sums
        // may be added in another order: equal to rounding, not to the bit.
        expect(got[key] as number).toBeCloseTo(value, 6);
      } else {
        expect(got[key]).toEqual(value);
      }
    }
  });
}

describe("foldUserRollupHistory", () => {
  it("writes the rows one pass over the whole window writes", async () => {
    const user = await makeUser();
    await seedHistory(user.id);

    await recomputeUserRollups(user.id);
    const onePass = await snapshot(user.id);
    expect(onePass.length).toBeGreaterThan(50);
    expect(onePass.some((r) => r.granularity === "WEEK")).toBe(true);

    await prisma.measurementRollup.deleteMany({ where: { userId: user.id } });
    const done = await foldUserRollupHistory(user.id, {
      statementTimeoutMs: ROLLUP_FULL_BACKFILL_STATEMENT_BUDGET_MS,
    });
    expect(done.windowsFolded).toBeGreaterThanOrEqual(5);
    expect(done.resumeBefore).toBeUndefined();
    expectSameRows(await snapshot(user.id), onePass);
    expect(
      (await snapshot(user.id)).every(
        (r) => r.readingMinValue !== null && r.readingMaxValue !== null,
      ),
    ).toBe(true);
  });

  it("ends in the same rows when stopped part way and resumed", async () => {
    const user = await makeUser();
    await seedHistory(user.id);
    await recomputeUserRollups(user.id);
    const onePass = await snapshot(user.id);
    await prisma.measurementRollup.deleteMany({ where: { userId: user.id } });

    // Stop on the seventh question: inside the second window.
    let asked = 0;
    const first = await foldUserRollupHistory(user.id, {
      shouldStop: () => ++asked >= 7,
    });
    expect(first.windowsFolded).toBe(1);
    expect(first.resumeBefore).toBeDefined();

    const rest = await foldUserRollupHistory(user.id, {
      before: first.resumeBefore,
    });
    expect(rest.resumeBefore).toBeUndefined();
    expectSameRows(await snapshot(user.id), onePass);
  });
});

/** The discovery statement before the day walk, verbatim. */
async function referenceDiscovery(): Promise<string[]> {
  const foldWindowStart = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
  const users = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT id FROM (
      SELECT DISTINCT mt."user_id" AS id
      FROM (
        SELECT DISTINCT
          m."user_id",
          m."type",
          date_trunc('day', m."measured_at") AS bucket_start
        FROM measurements m
        WHERE m."deleted_at" IS NULL
          AND m."measured_at" >= ${foldWindowStart}
      ) mt
      LEFT JOIN measurement_rollups r
        ON  r."user_id"     = mt."user_id"
        AND r."type"        = mt."type"
        AND r."granularity" = 'DAY'
        AND r."bucket_start" = mt."bucket_start"
      WHERE r."bucket_start" IS NULL

      UNION

      SELECT DISTINCT r."user_id" AS id
      FROM measurement_rollups r
      WHERE r."granularity" = 'DAY'
        AND r."bucket_start" >= ${foldWindowStart}
        AND (r."sum_xy" IS NULL OR r."reading_min_value" IS NULL)
    ) discovered
    WHERE ${activeAccountSql('discovered."id"')}
  `;
  return users.map((u) => u.id).sort();
}

describe("enqueueBootTimeRollupBackfill", () => {
  it("finds the accounts the statement it replaced found", async () => {
    const covered = await makeUser();
    const missingDay = await makeUser();
    const nullExtremes = await makeUser();
    const tombstoneOnly = await makeUser();
    const tooOld = await makeUser();
    const pendingDeletion = await makeUser();
    for (const u of [covered, missingDay, nullExtremes, pendingDeletion]) {
      await seedHistory(u.id);
      await recomputeUserRollups(u.id);
    }
    // A reading on a day with no DAY bucket.
    await prisma.measurement.create({
      data: {
        userId: missingDay.id,
        type: "BODY_FAT",
        value: 20,
        unit: "%",
        source: "MANUAL",
        measuredAt: new Date(Date.now() - 40 * DAY_MS),
      },
    });
    await prisma.measurement.create({
      data: {
        userId: pendingDeletion.id,
        type: "BODY_FAT",
        value: 20,
        unit: "%",
        source: "MANUAL",
        measuredAt: new Date(Date.now() - 40 * DAY_MS),
      },
    });
    await prisma.user.update({
      where: { id: pendingDeletion.id },
      data: { deletionRequestedAt: new Date() },
    });
    // A row folded before 0417 added the reading extremes.
    await prisma.$executeRaw`
      UPDATE measurement_rollups SET reading_min_value = NULL
      WHERE user_id = ${nullExtremes.id} AND granularity = 'DAY'
        AND bucket_start = (
          SELECT max(bucket_start) FROM measurement_rollups
          WHERE user_id = ${nullExtremes.id} AND granularity = 'DAY'
        )
    `;
    // Only a tombstone inside the window: nothing to fold.
    await prisma.measurement.create({
      data: {
        userId: tombstoneOnly.id,
        type: "WEIGHT",
        value: 70,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(Date.now() - 10 * DAY_MS),
        deletedAt: new Date(),
      },
    });
    // Only readings older than the window: the fold writes nothing there.
    await prisma.measurement.create({
      data: {
        userId: tooOld.id,
        type: "WEIGHT",
        value: 70,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS - 5 * DAY_MS),
      },
    });

    const send = vi.fn(async () => "job-id");
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);
    const result = await enqueueBootTimeRollupBackfill();
    expect(result.error).toBeNull();
    const found = (
      send.mock.calls as unknown as Array<[string, { userId: string }]>
    )
      .map((call) => call[1].userId)
      .sort();

    expect(found).toEqual([missingDay.id, nullExtremes.id].sort());
    expect(found).toEqual(await referenceDiscovery());
  });
});

describe("isRollupFullBackfillPending", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    await boss.createQueue(ROLLUP_FULL_BACKFILL_QUEUE);
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, close: true });
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS pgboss CASCADE`);
  });

  it("is true while the account's full fold is queued or running, and only for that account", async () => {
    expect(await isRollupFullBackfillPending("user-a")).toBe(false);
    await boss.send(ROLLUP_FULL_BACKFILL_QUEUE, { userId: "user-a" });
    expect(await isRollupFullBackfillPending("user-a")).toBe(true);
    expect(await isRollupFullBackfillPending("user-b")).toBe(false);
    const [job] = await boss.fetch(ROLLUP_FULL_BACKFILL_QUEUE);
    expect(await isRollupFullBackfillPending("user-a")).toBe(true);
    await boss.complete(ROLLUP_FULL_BACKFILL_QUEUE, job.id);
    expect(await isRollupFullBackfillPending("user-a")).toBe(false);
  });
});
