/**
 * The full-history extremes read the DAY rollup tier and give the figures the
 * raw-row fold gave.
 *
 * `readAllTimeExtremes` used to fold every raw reading of the four types on
 * each call. It now folds the DAY tier for the whole days inside the fold
 * window and the raw rows for the rest. The reference below is that earlier
 * query, verbatim, so the comparison is against what the function used to
 * answer, not against a second derivation of the same idea.
 *
 * The seed has what the two paths could disagree on: two sources on the same
 * days (weight by scale and by hand, pulse from a watch's hourly statistics
 * with their own range and a strap's dense samples), readings older than the
 * fold window, readings either side of a UTC midnight, soft-deleted rows, and
 * a reading deleted after the tier was built (through the write path's own
 * rollup recompute).
 *
 * Means are compared to nine significant digits: the tier sums the same day
 * values in a different order. Extremes are compared exactly.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { Prisma, type MeasurementType } from "@/generated/prisma/client";
import { readAllTimeExtremes } from "@/lib/insights/feature-blocks";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import {
  dayWeightedRowsSql,
  foldMeanSql,
  isHourlyMeanTypeSql,
} from "@/lib/measurements/day-mean";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { recomputeUserRollups } from "@/lib/rollups/measurement-rollups";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";

const prisma = getPrismaClient();
const USER = "all-time-tier-parity";
const TYPES: MeasurementType[] = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const today = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);

/** The query `readAllTimeExtremes` ran before it read the DAY tier. */
async function referenceExtremes(
  userId: string,
  types: readonly MeasurementType[],
  floor: Date | null,
) {
  const out = new Map<string, { mean: number; min: number; max: number }>();
  const since =
    floor === null ? Prisma.empty : Prisma.sql`AND m."measured_at" >= ${floor}`;
  const priorityJson = await loadUserSourcePriority(userId);
  const rank = Prisma.raw(
    buildSourceRankCase(priorityJson, 'p."type"', 'p."source"'),
  );
  const typeList = Prisma.join(
    types.map((t) => Prisma.sql`${t}::measurement_type`),
  );
  const mean = Prisma.raw(
    foldMeanSql({
      typeColumn: 'c."type"',
      total: "c.total",
      count: "c.cnt",
      weightedSum: "c.wsum",
      weightSum: "c.wdays",
    }),
  );
  const rows = await prisma.$queryRaw<
    Array<{ type: string; mean: number; min: number; max: number }>
  >`
    WITH hourly_src AS (
      SELECT m.*
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."type" IN (${typeList})
        ${since}
        AND ${Prisma.raw(isHourlyMeanTypeSql('m."type"'))}
    ),
    weighted AS (
      SELECT
        w."type",
        w."source",
        date_trunc('day', w."measured_at")              AS day,
        SUM(w."value" * w.day_weight)::double precision AS wsum,
        SUM(w.day_weight)::double precision             AS wdays
      FROM ${dayWeightedRowsSql("hourly_src", null, { bySource: true })} w
      GROUP BY w."type", w."source", 3
    ),
    per_source AS (
      SELECT
        m."type",
        m."source",
        date_trunc('day', m."measured_at") AS day,
        COUNT(*)::int                      AS cnt,
        SUM(m."value")::double precision   AS total,
        MIN(m."value")::double precision   AS min_value,
        MAX(m."value")::double precision   AS max_value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."type" IN (${typeList})
        ${since}
      GROUP BY m."type", m."source", 3
    ),
    canon AS (
      SELECT DISTINCT ON (p."type", p.day)
        p."type", p.cnt, p.total, p.min_value, p.max_value, w.wsum, w.wdays
      FROM per_source p
      LEFT JOIN weighted w
        ON w."type" = p."type" AND w."source" = p."source" AND w.day = p.day
      ORDER BY p."type", p.day, (${rank}), p."source"::text
    )
    SELECT
      c."type"::text                                  AS type,
      ${mean}::double precision                       AS mean,
      MIN(c.min_value)::double precision              AS min,
      MAX(c.max_value)::double precision              AS max
    FROM canon c
    GROUP BY c."type"
  `;
  for (const r of rows) {
    out.set(r.type, { mean: r.mean, min: r.min, max: r.max });
  }
  return out;
}

/** A small deterministic generator, so a failure reproduces. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

function seed(): Prisma.MeasurementCreateManyInput[] {
  const rnd = lcg(7);
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  let n = 0;
  const add = (
    type: MeasurementType,
    unit: string,
    source: Prisma.MeasurementCreateManyInput["source"],
    at: number,
    value: number,
    extra: Partial<Prisma.MeasurementCreateManyInput> = {},
  ) => {
    n += 1;
    rows.push({
      id: `${USER}-${n}`,
      userId: USER,
      type,
      unit,
      source,
      value,
      measuredAt: new Date(at),
      ...extra,
    });
  };
  // Weight and blood pressure across six years: older than the fold window
  // too. Every fifth day a hand entry beside the scale's, every 23rd day a
  // reading a minute either side of UTC midnight, and a few tombstones.
  for (let d = 6 * 365; d >= 0; d -= 1) {
    const day = today - d * DAY;
    add("WEIGHT", "kg", "WITHINGS", day + 6 * HOUR, 70 + 10 * rnd());
    if (d % 5 === 0)
      add("WEIGHT", "kg", "MANUAL", day + 20 * HOUR, 69 + 12 * rnd());
    for (const [type, base] of [
      ["BLOOD_PRESSURE_SYS", 110],
      ["BLOOD_PRESSURE_DIA", 65],
    ] as const) {
      add(type, "mmHg", "WITHINGS", day + 7 * HOUR, base + 40 * rnd());
      if (d % 23 === 0) {
        add(type, "mmHg", "WITHINGS", day - 60_000, base + 45 * rnd());
        add(type, "mmHg", "WITHINGS", day + 60_000, base - 5 + 50 * rnd());
      }
      if (d % 31 === 0) {
        add(type, "mmHg", "WITHINGS", day + 9 * HOUR, base + 80, {
          deletedAt: new Date(),
        });
      }
    }
  }
  // Pulse over the last 400 days: a watch's hourly statistics carrying the
  // hour's own min / max, and a strap's dense samples on every other day.
  for (let d = 400; d >= 0; d -= 1) {
    const day = today - d * DAY;
    for (let h = 0; h < 24; h += 3) {
      const avg = 55 + 30 * rnd();
      add("PULSE", "bpm", "APPLE_HEALTH", day + h * HOUR, avg, {
        valueMin: avg - 15,
        valueMax: avg + 40,
        externalId: `stats:HKQuantityTypeIdentifierHeartRate:${day + h * HOUR}`,
      });
    }
    if (d % 2 === 0) {
      for (let i = 0; i < 30; i += 1) {
        add(
          "PULSE",
          "bpm",
          "WHOOP",
          day + 10 * HOUR + i * 120_000,
          50 + 70 * rnd(),
        );
      }
    }
  }
  return rows;
}

async function expectParity(floor: Date | null) {
  const [actual, reference] = await Promise.all([
    readAllTimeExtremes(USER, TYPES, floor),
    referenceExtremes(USER, TYPES, floor),
  ]);
  expect([...actual.keys()].sort()).toEqual([...reference.keys()].sort());
  expect(reference.size).toBe(4);
  for (const [type, ref] of reference) {
    const got = actual.get(type as MeasurementType)!;
    expect(got.min, type).toBe(ref.min);
    expect(got.max, type).toBe(ref.max);
    expect(got.mean! / ref.mean, type).toBeCloseTo(1, 9);
  }
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: { id: USER, username: USER, timezone: "Pacific/Auckland" },
  });
  const rows = seed();
  for (let i = 0; i < rows.length; i += 5000) {
    await prisma.measurement.createMany({ data: rows.slice(i, i + 5000) });
  }
  await recomputeUserRollups(USER, { granularities: ["DAY"] });
}, 300_000);

describe("readAllTimeExtremes over the DAY tier", () => {
  // A clean tier over whatever rows are left for every case: some cases
  // break a tier row on purpose, and the next case must not read it.
  beforeEach(async () => {
    await recomputeUserRollups(USER, { granularities: ["DAY"] });
  }, 120_000);

  it("reads the tier for every type", async () => {
    const covered = await prisma.measurementRollup.groupBy({
      by: ["type"],
      where: {
        userId: USER,
        granularity: "DAY",
        readingMinValue: { not: null },
      },
    });
    expect(covered.map((c) => c.type).sort()).toEqual([...TYPES].sort());
  });

  it("gives the raw fold's figures over the whole history", async () => {
    await expectParity(null);
  });

  it("gives the raw fold's figures from a floor inside a day", async () => {
    await expectParity(new Date(today - 200 * DAY + 13 * HOUR + 17 * 60_000));
  });

  it("follows a deletion through the write path's recompute", async () => {
    const hottest = await prisma.measurement.findFirst({
      where: { userId: USER, type: "PULSE", source: "WHOOP", deletedAt: null },
      orderBy: { value: "desc" },
    });
    await prisma.measurement.update({
      where: { id: hottest!.id },
      data: { deletedAt: new Date() },
    });
    await afterMeasurementMutation(
      USER,
      [{ type: "PULSE", measuredAt: hottest!.measuredAt }],
      { source: "manual" },
    );
    await expectParity(null);
  });

  it("is the tier that answers, not the raw rows", async () => {
    // Write it, then break it: a tier row raised past every reading must
    // move the answer, or the parity above proved nothing about the tier.
    const day = new Date(today - 3 * DAY);
    await prisma.measurementRollup.updateMany({
      where: {
        userId: USER,
        type: "WEIGHT",
        granularity: "DAY",
        bucketStart: day,
      },
      data: { readingMaxValue: 999 },
    });
    const out = await readAllTimeExtremes(USER, ["WEIGHT"]);
    expect(out.get("WEIGHT")?.max).toBe(999);
  });

  it("reads the raw rows for a type with a tier row lacking the extremes", async () => {
    const day = new Date(today - 3 * DAY);
    await prisma.measurementRollup.updateMany({
      where: {
        userId: USER,
        type: "WEIGHT",
        granularity: "DAY",
        bucketStart: day,
      },
      data: { readingMinValue: null },
    });
    const [actual, reference] = await Promise.all([
      readAllTimeExtremes(USER, ["WEIGHT"]),
      referenceExtremes(USER, ["WEIGHT"], null),
    ]);
    expect(actual.get("WEIGHT")?.max).toBe(reference.get("WEIGHT")?.max);
    expect(actual.get("WEIGHT")?.min).toBe(reference.get("WEIGHT")?.min);
  });

  it("reads the raw rows for a type whose tier outlived a hard delete", async () => {
    // Rebuild a clean tier, then delete the hottest pulse reading with no
    // rollup recompute: its DAY row now counts a reading that is gone.
    await recomputeUserRollups(USER, { granularities: ["DAY"] });
    const hottest = await prisma.measurement.findFirst({
      where: { userId: USER, type: "PULSE", deletedAt: null },
      orderBy: { value: "desc" },
    });
    await prisma.measurement.delete({ where: { id: hottest!.id } });
    const stale = await prisma.measurementRollup.findMany({
      where: {
        userId: USER,
        type: "PULSE",
        granularity: "DAY",
        readingMaxValue: hottest!.value,
      },
    });
    expect(stale.length).toBeGreaterThan(0);
    await expectParity(null);
    const out = await readAllTimeExtremes(USER, ["PULSE"]);
    expect(out.get("PULSE")?.max).toBeLessThan(hottest!.value);
  });
});
