/**
 * Migration 0373 rewrites the `mean` of stored PULSE rollup rows to the
 * hourly-mean statistic, and touches nothing else.
 *
 * The rows are first built by the writer, then their `mean` is set to a
 * sentinel the way a row written before this release still holds the reading
 * mean. The migration must restore exactly what the writer stores now: DAY =
 * mean of the day's hour means, WEEK / MONTH / YEAR = mean of their days. A
 * second type (HRV) with the same readings keeps its sentinel, every other
 * column keeps its value, and a rerun changes nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type { Prisma } from "@/generated/prisma/client";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";

const prisma = getPrismaClient();
const USER = "pulse-mean-migration";
const SENTINEL = 999;

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "prisma",
    "migrations",
    "0373_pulse_hourly_mean_day",
    "migration.sql",
  ),
  "utf8",
);

function steps(): string[] {
  return MIGRATION.split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runMigration(): Promise<void> {
  // One connection: the temporary tables live in the session that made them.
  await prisma.$transaction(async (tx) => {
    for (const step of steps()) await tx.$executeRawUnsafe(step);
  });
}

/** Tuesday 2026-03-03: one hard hour of 12 readings at 150, three hours of one reading at 60. */
const TUE = Date.UTC(2026, 2, 3);
/** Wednesday: two hours at 70. */
const WED = Date.UTC(2026, 2, 4);
const TUE_VALUE = (150 + 3 * 60) / 4;
const WED_VALUE = 70;

function rows(
  type: "PULSE" | "HEART_RATE_VARIABILITY",
): Prisma.MeasurementCreateManyInput[] {
  const out: Prisma.MeasurementCreateManyInput[] = [];
  const add = (at: number, value: number) =>
    out.push({
      id: `${type}-${at}`,
      userId: USER,
      type,
      unit: type === "PULSE" ? "bpm" : "ms",
      source: "APPLE_HEALTH",
      value,
      measuredAt: new Date(at),
    });
  for (let i = 0; i < 12; i += 1) add(TUE + 10 * 3_600_000 + i * 300_000, 150);
  for (const h of [12, 14, 16]) add(TUE + h * 3_600_000, 60);
  for (const h of [8, 9]) add(WED + h * 3_600_000, 70);
  return out;
}

type Row = {
  type: string;
  granularity: string;
  bucket_start: Date;
  count: number;
  mean: number;
  min_value: number;
  max_value: number;
  sum_value: number | null;
  sd: number | null;
  sum_x: number | null;
  sum_xy: number | null;
  sum_xx: number | null;
  sum_yy: number | null;
};

const readRows = () =>
  prisma.$queryRaw<Row[]>`
    SELECT "type"::text AS type, "granularity"::text AS granularity,
           "bucket_start", "count", "mean", "min_value", "max_value",
           "sum_value", "sd", "sum_x", "sum_xy", "sum_xx", "sum_yy"
    FROM measurement_rollups
    WHERE "user_id" = ${USER}
    ORDER BY 1, 2, 3
  `;

let before: Row[] = [];

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "UTC" },
  });
  await prisma.measurement.createMany({
    data: [...rows("PULSE"), ...rows("HEART_RATE_VARIABILITY")],
  });
  await recomputeUserRollups(USER, {
    types: ["PULSE", "HEART_RATE_VARIABILITY"],
    from: new Date(Date.UTC(2026, 0, 1)),
    to: new Date(Date.UTC(2027, 0, 1)),
  });
  await prisma.$executeRaw`
    UPDATE measurement_rollups SET "mean" = ${SENTINEL} WHERE "user_id" = ${USER}
  `;
  before = await readRows();
  await runMigration();
}, 120_000);

const meanOf = (all: Row[], type: string, granularity: string, at?: number) =>
  all.find(
    (r) =>
      r.type === type &&
      r.granularity === granularity &&
      (at === undefined || r.bucket_start.getTime() === at),
  )?.mean;

describe("migration 0373", () => {
  it("covers all four granularities of both types", () => {
    for (const type of ["PULSE", "HEART_RATE_VARIABILITY"]) {
      for (const g of ["DAY", "WEEK", "MONTH", "YEAR"]) {
        expect(meanOf(before, type, g)).toBe(SENTINEL);
      }
    }
  });

  it("gives a PULSE day the mean of its hours' means", async () => {
    const after = await readRows();
    expect(meanOf(after, "PULSE", "DAY", TUE)).toBeCloseTo(TUE_VALUE, 9);
    expect(meanOf(after, "PULSE", "DAY", WED)).toBeCloseTo(WED_VALUE, 9);
  });

  it("gives a PULSE week, month and year the mean of their days", async () => {
    const after = await readRows();
    for (const g of ["WEEK", "MONTH", "YEAR"]) {
      expect(meanOf(after, "PULSE", g)).toBeCloseTo(
        (TUE_VALUE + WED_VALUE) / 2,
        9,
      );
    }
  });

  it("matches what the writer stores now", async () => {
    const migrated = await readRows();
    await recomputeUserRollups(USER, {
      types: ["PULSE"],
      from: new Date(Date.UTC(2026, 0, 1)),
      to: new Date(Date.UTC(2027, 0, 1)),
    });
    const written = await readRows();
    for (const r of written.filter((x) => x.type === "PULSE")) {
      const m = migrated.find(
        (x) =>
          x.type === r.type &&
          x.granularity === r.granularity &&
          x.bucket_start.getTime() === r.bucket_start.getTime(),
      );
      expect(m?.mean).toBeCloseTo(r.mean, 9);
    }
    // Restore the migrated state for the remaining assertions.
    await prisma.$executeRaw`
      UPDATE measurement_rollups SET "mean" = ${SENTINEL}
      WHERE "user_id" = ${USER} AND "type" = 'HEART_RATE_VARIABILITY'
    `;
  });

  it("leaves every other type's mean alone", async () => {
    const after = await readRows();
    for (const r of after.filter((x) => x.type !== "PULSE")) {
      expect(r.mean).toBe(SENTINEL);
    }
  });

  it("leaves every column but mean alone", async () => {
    const after = await readRows();
    const strip = ({ mean: _mean, ...rest }: Row) => rest;
    expect(after.map(strip)).toEqual(before.map(strip));
  });

  it("is idempotent", async () => {
    const first = await readRows();
    await runMigration();
    expect(await readRows()).toEqual(first);
  });
});
