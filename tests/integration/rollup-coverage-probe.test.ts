/**
 * The rollup coverage probe reads the distinct live types as a loose index
 * scan and coverage as a per-type `EXISTS`. The previous shape (a DISTINCT
 * over every live row joined to a COUNT over every DAY bucket) is kept here
 * as the oracle: both must return the same map on the same fixture, including
 * the edges that decide the read-swap — tombstoned types, types with only
 * coarser buckets, another account's buckets, and an account with nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { probeRollupCoverage } from "@/lib/rollups/measurement-coverage";
import type { MeasurementType } from "@/generated/prisma/client";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => null),
}));

const USER = "user-coverage-probe";
const OTHER = "user-coverage-probe-other";
const EMPTY = "user-coverage-probe-empty";

async function oracle(userId: string): Promise<Map<string, boolean>> {
  const rows = await getPrismaClient().$queryRaw<
    Array<{ type: string; has_buckets: boolean }>
  >`
    SELECT m."type"::text AS type, COUNT(r.*) > 0 AS has_buckets
    FROM (
      SELECT DISTINCT "type" FROM measurements
      WHERE user_id = ${userId} AND "deleted_at" IS NULL
    ) m
    LEFT JOIN measurement_rollups r
      ON r.user_id = ${userId} AND r."type" = m."type" AND r.granularity = 'DAY'
    GROUP BY m."type"
  `;
  return new Map(rows.map((r) => [r.type, Boolean(r.has_buckets)]));
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  for (const id of [USER, OTHER, EMPTY]) {
    await prisma.user.create({
      data: { id, username: id, email: `${id}@example.test`, timezone: "UTC" },
    });
  }
});

describe("probeRollupCoverage", () => {
  it("matches the full-scan oracle across tombstones, granularities and accounts", async () => {
    const prisma = getPrismaClient();
    const day = 86_400_000;
    const base = Date.UTC(2026, 0, 10);
    const reading = (
      userId: string,
      type: MeasurementType,
      i: number,
      deleted = false,
    ) => ({
      userId,
      type,
      value: 60 + i,
      unit: "x",
      measuredAt: new Date(base + i * day),
      deletedAt: deleted ? new Date(base) : null,
    });
    await prisma.measurement.createMany({
      data: [
        // Live rows with DAY buckets → covered.
        ...[0, 1, 2].map((i) => reading(USER, "PULSE", i)),
        // Live rows, no buckets at all → uncovered.
        ...[0, 1].map((i) => reading(USER, "WEIGHT", i)),
        // Live rows with only a WEEK bucket → uncovered.
        reading(USER, "BLOOD_PRESSURE_SYS", 0),
        // Only tombstones → absent from the map, even with a DAY bucket.
        ...[0, 1].map((i) => reading(USER, "SLEEP_DURATION", i, true)),
        // A mix of tombstoned and live rows → present.
        reading(USER, "ACTIVITY_STEPS", 0, true),
        reading(USER, "ACTIVITY_STEPS", 1),
        // Another account's rows and buckets never leak in.
        reading(OTHER, "WEIGHT", 0),
        reading(OTHER, "OXYGEN_SATURATION", 0),
      ],
    });
    const bucket = (
      userId: string,
      type: MeasurementType,
      granularity: "DAY" | "WEEK",
    ) => ({
      userId,
      type,
      granularity,
      bucketStart: new Date(base),
      source: "MANUAL" as const,
      count: 1,
      mean: 1,
      minValue: 1,
      maxValue: 1,
    });
    await prisma.measurementRollup.createMany({
      data: [
        bucket(USER, "PULSE", "DAY"),
        bucket(USER, "BLOOD_PRESSURE_SYS", "WEEK"),
        bucket(USER, "SLEEP_DURATION", "DAY"),
        bucket(USER, "ACTIVITY_STEPS", "DAY"),
        bucket(OTHER, "WEIGHT", "DAY"),
        bucket(USER, "OXYGEN_SATURATION", "DAY"),
      ],
    });

    const coverage = await probeRollupCoverage(USER);
    expect(Object.fromEntries(coverage)).toEqual({
      ACTIVITY_STEPS: true,
      BLOOD_PRESSURE_SYS: false,
      PULSE: true,
      WEIGHT: false,
    });
    expect(coverage).toEqual(await oracle(USER));
    expect(await probeRollupCoverage(OTHER)).toEqual(await oracle(OTHER));

    const empty = await probeRollupCoverage(EMPTY);
    expect(empty.size).toBe(0);
    expect(empty).toEqual(await oracle(EMPTY));
  });
});
