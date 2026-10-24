/**
 * The dense-series read, against a real Postgres: the shipped single
 * statement (`readDenseSeries`) against the two statements it replaced,
 * kept below as the reference (the bucket SQL and the figures SQL are the
 * same builders, so the reference differs only in reading the canonical rows
 * twice instead of once).
 *
 * Buckets and figures must match for every shape the route asks for: day
 * and hour grains; an hourly-mean type (pulse, two ranked sources), an
 * unranked dense type (glucose) and a ranked non-hourly one (oxygen
 * saturation); zones with a DST change and a half-hour offset; a fixture
 * with gaps, tombstones and readings around local and UTC midnight.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import {
  denseBucketsSql,
  denseFiguresSql,
  readDenseSeries,
  type DenseBucketRow,
  type DenseFigures,
} from "@/lib/measurements/dense-series-read";
import { seriesRowsFrom } from "@/lib/measurements/series-canonical";

import { makeUser } from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY_MS = 86_400_000;

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

  for (const [type, grain, days] of CASES) {
    for (const userTz of ZONES) {
      it(`matches the two statements: ${type}, ${grain}, ${days} d, ${userTz}`, async () => {
        const since = new Date(Date.now() - days * DAY_MS);
        const args = {
          userId,
          type,
          grain,
          userTz,
          since,
          seriesRows: seriesRowsFrom(null, type, since),
        };
        const [now, before] = await Promise.all([
          readDenseSeries(args),
          legacyDenseSeries(args),
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

  it("answers no figures row for an hourly-mean type without readings, as before", async () => {
    const empty = await makeUser();
    const since = new Date(Date.now() - 365 * DAY_MS);
    const args = {
      userId: empty.id,
      type: "PULSE" as const,
      grain: "day" as const,
      userTz: "UTC",
      since,
      seriesRows: seriesRowsFrom(null, "PULSE", since),
    };
    const [now, before] = await Promise.all([
      readDenseSeries(args),
      legacyDenseSeries(args),
    ]);
    expect(now).toEqual(before);
    expect(now.rawAgg).toBeUndefined();
  });
});
