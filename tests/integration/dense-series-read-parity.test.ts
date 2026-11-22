/**
 * The dense-series read, against a real Postgres: the shipped statement
 * (`readDenseSeries`, which folds the readings into cells and picks the
 * source per day over the cells) against the two statements over the
 * canonical raw rows it replaced, kept below as the reference.
 *
 * Buckets and figures must match for every shape the route asks for: day
 * and hour grains; an hourly-mean type (pulse, two ranked sources), an
 * unranked dense type (glucose) and a ranked non-hourly one (oxygen
 * saturation); zones with a DST change and a half-hour offset; a fixture
 * with gaps, tombstones and readings around local and UTC midnight; the
 * default ladders and a user ladder that reverses the pulse order.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import {
  dayWeightedRows,
  hourWeightSql,
  weightedHourMeanSql,
  windowMeanSql,
  zoneDayFrame,
} from "@/lib/measurements/day-mean";
import {
  readDenseSeries,
  type DenseBucketRow,
  type DenseFigures,
} from "@/lib/measurements/dense-series-read";
import { seriesRowsFrom } from "@/lib/measurements/series-canonical";

import { makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY_MS = 86_400_000;

// The bucket and figures statements over the canonical raw rows, as they
// stood before the read folded the readings into cells.

/** The bucket aggregate over `src`, in the original statement's SQL. */
function denseBucketsSql(hourWeighted: boolean, from: string): string {
  return hourWeighted
    ? `
      WITH localized AS (
        SELECT
          m."value",
          m."value_min",
          m."value_max",
          date_trunc(
            'hour',
            (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE $3
          ) AS local_hour
        FROM ${from}
      ),
      hourly AS (
        SELECT
          date_trunc($2, local_hour)                              AS local_day,
          AVG("value")                                            AS hour_mean,
          COUNT(*)                                                AS n,
          MIN(COALESCE("value_min", "value"))                     AS min_value,
          MAX(COALESCE("value_max", "value"))                     AS max_value
        FROM localized
        GROUP BY local_hour
      )
      SELECT
        local_day AT TIME ZONE $3                                AS bucket_start,
        ${weightedHourMeanSql("hour_mean", hourWeightSql("n"))}::double precision AS mean,
        MIN(min_value)::double precision                         AS min_value,
        MAX(max_value)::double precision                         AS max_value
      FROM hourly
      GROUP BY local_day`
    : `
      WITH localized AS (
        SELECT
          m."value",
          m."value_min",
          m."value_max",
          -- An hour bucket starts at the reading's instant less its minutes
          -- and seconds on the local clock. Truncating the local wall clock
          -- instead merged the two hours a fall-back night repeats into one
          -- bucket.
          CASE
            WHEN $2 = 'hour' THEN (
              m."measured_at" - (
                ((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE $3)
                - date_trunc('hour', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE $3)
              )
            ) AT TIME ZONE 'UTC'
            ELSE date_trunc(
              $2,
              (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE $3
            ) AT TIME ZONE $3
          END AS bucket_start
        FROM ${from}
      )
      SELECT
        bucket_start,
        AVG("value")::double precision                           AS mean,
        MIN(COALESCE("value_min", "value"))::double precision    AS min_value,
        MAX(COALESCE("value_max", "value"))::double precision    AS max_value
      FROM localized
      GROUP BY bucket_start`;
}

/** The figures aggregate over the CTE `src`, in the original SQL. */
function denseFiguresSql(hourlyMean: boolean): string {
  return hourlyMean
    ? `
      SELECT
        COUNT(*)::int                            AS n,
        ${windowMeanSql({ typeColumn: 'm."type"', value: 'm."value"', weight: "m.day_weight" })}::double precision
                                                 AS mean,
        MIN(m."value")::double precision         AS min,
        MAX(m."value")::double precision         AS max,
        STDDEV_POP(m."value")::double precision  AS sd
      FROM ${dayWeightedRows("src", zoneDayFrame("$3"))} m
      GROUP BY m."type"`
    : `
      SELECT
        COUNT(*)::int                            AS n,
        AVG(m."value")::double precision         AS mean,
        MIN(m."value")::double precision         AS min,
        MAX(m."value")::double precision         AS max,
        STDDEV_POP(m."value")::double precision  AS sd
      FROM src m`;
}

/** The two statements as the route sent them before. */
async function legacyDenseSeries(args: {
  userId: string;
  type: MeasurementType;
  grain: "day" | "hour";
  userTz: string;
  since: Date;
  seriesRows: string;
}) {
  const hourWeighted = args.grain === "day" && usesHourlyMeanDay(args.type);
  const bucketRows = await prisma.$queryRawUnsafe<DenseBucketRow[]>(
    `${denseBucketsSql(hourWeighted, `${args.seriesRows} WHERE m."measured_at" >= $4`)}
      ORDER BY bucket_start ASC`,
    args.userId,
    args.grain,
    args.userTz,
    args.since,
  );
  // The figures statement took the window start as `$2` and the zone as
  // `$3`, the latter only for an hourly-mean type.
  const hourly = usesHourlyMeanDay(args.type);
  const [rawAgg] = await prisma.$queryRawUnsafe<DenseFigures[]>(
    `WITH src AS (SELECT m.* FROM ${args.seriesRows} WHERE m."measured_at" >= $2)
      ${denseFiguresSql(hourly)}`,
    args.userId,
    args.since,
    ...(hourly ? [args.userTz] : []),
  );
  return { bucketRows, rawAgg };
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let userId = "";

async function seed() {
  userId = (await makeUser({ timezone: "Europe/Berlin" })).id;
  const random = rng(7);
  const now = Date.now();
  const rows: Array<{
    userId: string;
    type: MeasurementType;
    source: MeasurementSource;
    value: number;
    valueMin: number | null;
    valueMax: number | null;
    unit: string;
    measuredAt: Date;
    deletedAt: Date | null;
  }> = [];
  const plan: Array<[MeasurementType, MeasurementSource[], number]> = [
    ["PULSE", ["APPLE_HEALTH", "WITHINGS"], 60],
    ["BLOOD_GLUCOSE", ["NIGHTSCOUT", "MANUAL"], 70],
    ["OXYGEN_SATURATION", ["APPLE_HEALTH", "WITHINGS"], 96],
  ];
  // 200 days: across the last two DST changes, with gaps.
  for (let day = 0; day < 200; day++) {
    if (day % 13 === 4) continue;
    const dayStart = Math.floor((now - day * DAY_MS) / DAY_MS) * DAY_MS;
    for (const [type, sources, base] of plan) {
      for (const source of sources) {
        if (random() < 0.3) continue;
        const readings = 3 + Math.floor(random() * 12);
        for (let r = 0; r < readings; r++) {
          const at = dayStart + Math.floor(random() * DAY_MS);
          const value = Math.round((base + random() * 30) * 10) / 10;
          const banded = type === "PULSE" && random() < 0.3;
          rows.push({
            userId,
            type,
            source,
            value,
            valueMin: banded ? value - 10 : null,
            valueMax: banded ? value + 15 : null,
            unit: "x",
            measuredAt: new Date(at),
            deletedAt: random() < 0.05 ? new Date() : null,
          });
        }
      }
    }
  }
  const seen = new Set<string>();
  await prisma.measurement.createMany({
    data: rows.filter((row) => {
      const key = `${row.type}|${row.source}|${row.measuredAt.getTime()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  });
}

const REVERSED = { pulse: ["WITHINGS", "APPLE_HEALTH"] };

const CASES: Array<[MeasurementType, "day" | "hour", number]> = [
  ["PULSE", "day", 180],
  ["PULSE", "hour", 60],
  ["BLOOD_GLUCOSE", "day", 180],
  ["BLOOD_GLUCOSE", "hour", 30],
  ["OXYGEN_SATURATION", "day", 120],
];
const ZONES = ["UTC", "Europe/Berlin", "Asia/Kolkata", "America/New_York"];

function close(a: number | null | undefined, b: number | null | undefined) {
  if (a == null || b == null) return expect(a ?? null).toBe(b ?? null);
  expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
}

describe("dense-series read parity", () => {
  beforeAll(async () => {
    await truncateAllTables(prisma);
    await seed();
  });

  const LADDERS: Array<[string, unknown]> = [
    ["default ladders", null],
    ["a reversed pulse ladder", REVERSED],
  ];
  for (const [type, grain, days] of CASES) {
    for (const userTz of ZONES) {
      for (const [ladder, priorityJson] of LADDERS) {
        if (priorityJson !== null && type !== "PULSE") continue;
        it(`matches the two statements: ${type}, ${grain}, ${days} d, ${userTz}, ${ladder}`, async () => {
          const since = new Date(Date.now() - days * DAY_MS);
          const args = { userId, type, grain, userTz, since, priorityJson };
          const [now, before] = await Promise.all([
            readDenseSeries(args),
            legacyDenseSeries({
              ...args,
              seriesRows: seriesRowsFrom(priorityJson, type, since),
            }),
          ]);
          expect(before.bucketRows.length).toBeGreaterThan(10);
          expect(now.bucketRows.map((r) => r.bucket_start.getTime())).toEqual(
            before.bucketRows.map((r) => r.bucket_start.getTime()),
          );
          now.bucketRows.forEach((row, i) => {
            const ref = before.bucketRows[i]!;
            close(row.mean, ref.mean);
            close(row.min_value, ref.min_value);
            close(row.max_value, ref.max_value);
          });
          expect(now.rawAgg?.n).toBe(before.rawAgg?.n);
          close(now.rawAgg?.mean, before.rawAgg?.mean);
          close(now.rawAgg?.min, before.rawAgg?.min);
          close(now.rawAgg?.max, before.rawAgg?.max);
          close(now.rawAgg?.sd, before.rawAgg?.sd);
        });
      }
    }
  }

  it("answers no figures row for an hourly-mean type without readings, as before", async () => {
    const empty = await makeUser();
    const since = new Date(Date.now() - 365 * DAY_MS);
    const args = {
      userId: empty.id,
      type: "PULSE" as const,
      grain: "day" as const,
      userTz: "UTC",
      since,
    };
    const [now, before] = await Promise.all([
      readDenseSeries({ ...args, priorityJson: null }),
      legacyDenseSeries({
        ...args,
        seriesRows: seriesRowsFrom(null, "PULSE", since),
      }),
    ]);
    expect(now).toEqual(before);
    expect(now.rawAgg).toBeUndefined();
  });
});
