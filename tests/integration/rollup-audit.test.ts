/**
 * The nightly rollup audit finds a middle day a failed recompute left behind
 * and refolds it.
 *
 * The readers that let the DAY tier stand in for the record check it at the
 * ends of their range only (`readTierCoveredTypes`). A write whose inline
 * bucket recompute failed, on a day between the ends, is invisible to them:
 * the first case shows the all-time figures serving the stale bucket. The
 * audit (`rollup-audit.ts`) compares every day written since its lookback
 * with its bucket, count and value sum, and refolds the ones that differ;
 * the figures are right again afterwards. A clean tier is left alone.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readAllTimeExtremes } from "@/lib/insights/feature-blocks";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import {
  auditRecentRollupDays,
  readDisagreeingDays,
} from "@/lib/rollups/rollup-audit";

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const prisma = getPrismaClient();
const USER = "rollup-audit";
const DAY_MS = 86_400_000;
const today = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);
const dayAt = (daysBack: number) =>
  new Date(today - daysBack * DAY_MS + 8 * 3_600_000);

/** Live readings and the DAY tier's sum for one day of a type. */
async function dayCounts(type: string, daysBack: number) {
  const [row] = await prisma.$queryRawUnsafe<
    Array<{ live: number; tier: number }>
  >(
    `SELECT
       (SELECT COUNT(*)::int FROM measurements
         WHERE user_id = $1 AND type = $2::measurement_type
           AND deleted_at IS NULL
           AND measured_at >= $3 AND measured_at < $3 + interval '1 day') AS live,
       (SELECT COALESCE(SUM(count), 0)::int FROM measurement_rollups
         WHERE user_id = $1 AND type = $2::measurement_type
           AND granularity = 'DAY' AND bucket_start = $4) AS tier`,
    USER,
    type,
    new Date(today - daysBack * DAY_MS),
    new Date(today - daysBack * DAY_MS),
  );
  return row;
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  await prisma.measurement.createMany({
    data: Array.from({ length: 10 }, (_, d) => ({
      userId: USER,
      type: "WEIGHT" as const,
      value: 70 + d,
      unit: "kg",
      source: "WITHINGS" as const,
      measuredAt: dayAt(d),
    })),
  });
  await recomputeUserRollups(USER);
}, 120_000);

describe("the nightly rollup audit", () => {
  it("leaves a tier that matches the record alone", async () => {
    const before = await readDisagreeingDays(
      USER,
      new Date(Date.now() - 48 * 3_600_000),
    );
    expect(before.checked).toBe(10);
    expect(before.disagreeing).toEqual([]);
    const summary = await auditRecentRollupDays();
    expect(summary.daysRefolded).toBe(0);
    expect(summary.usersFailed).toBe(0);
  });

  it("finds and refolds a middle day a failed recompute left behind", async () => {
    // Two writes whose bucket recompute never ran: a second scale reading
    // added to day 5, and the reading of day 6 edited in place (same count,
    // other value). The scale is the day's canonical source.
    await prisma.$executeRawUnsafe(
      `INSERT INTO measurements
         (id, user_id, type, value, unit, source, measured_at, updated_at)
       VALUES ('audit-extra', $1, 'WEIGHT', 120, 'kg', 'WITHINGS', $2, now())`,
      USER,
      new Date(dayAt(5).getTime() + 3_600_000),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE measurements SET value = 40, updated_at = now()
        WHERE user_id = $1 AND measured_at = $2`,
      USER,
      dayAt(6),
    );
    expect(await dayCounts("WEIGHT", 5)).toEqual({ live: 2, tier: 1 });

    // The read path checks the ends only, so it serves the stale buckets.
    const stale = await readAllTimeExtremes(USER, ["WEIGHT"]);
    expect(stale.get("WEIGHT")).toMatchObject({ min: 70, max: 79 });

    const found = await readDisagreeingDays(
      USER,
      new Date(Date.now() - 48 * 3_600_000),
    );
    expect(found.disagreeing.map((d) => d.day.toISOString()).sort()).toEqual([
      new Date(today - 6 * DAY_MS).toISOString(),
      new Date(today - 5 * DAY_MS).toISOString(),
    ]);

    const summary = await auditRecentRollupDays();
    expect(summary.daysRefolded).toBe(2);
    expect(await dayCounts("WEIGHT", 5)).toEqual({ live: 2, tier: 2 });
    const healed = await readAllTimeExtremes(USER, ["WEIGHT"]);
    expect(healed.get("WEIGHT")).toMatchObject({ min: 40, max: 120 });

    // And the next pass finds nothing left to refold.
    expect((await auditRecentRollupDays()).daysRefolded).toBe(0);
  });

  it("looks only at what was written inside its lookback", async () => {
    const summary = await auditRecentRollupDays({
      now: new Date(Date.now() + 72 * 3_600_000),
    });
    expect(summary.daysChecked).toBe(0);
  });
});
