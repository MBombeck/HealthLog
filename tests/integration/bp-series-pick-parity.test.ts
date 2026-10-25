/**
 * The blood-pressure series pick, against a real Postgres: the shipped
 * statement (one window function over one scan names each UTC day's source)
 * against the `DISTINCT ON` pick over the day's systolic rows joined back to
 * the readings, kept verbatim below as the reference.
 *
 * Both must return exactly the same rows in the same order, under the
 * default ladder and under user ladders that reorder it, for window starts
 * mid-day, on and either side of UTC midnight and on a local midnight, under
 * a UTC session and under sessions in other zones (the day cut reads the
 * session zone in both statements), over a fixture that carries what could
 * tell them apart: overlapping sources on one day, sources off the ladder
 * (the name tiebreak decides), a source whose only systolic that day is
 * below the floor, a diastolic below its floor, a diastolic with no
 * systolic, a systolic with no diastolic, tombstones, readings a minute
 * either side of UTC midnight, both DST changes in the user's zone, empty
 * days, and several readings per source per day.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { MeasurementSource } from "@/generated/prisma/client";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { bloodPressureSeriesSql } from "@/lib/measurements/series/read-blood-pressure";
import { VALUE_RANGES } from "@/lib/validations/measurement";

import { makeUser } from "../kit/factories";

import { getPrismaClient, truncateAllTables } from "./setup";

const USER_ID = "user-bp-series-parity";
const DAY_MS = 86_400_000;
const SYS_MIN = VALUE_RANGES.BLOOD_PRESSURE_SYS.min;
const DIA_MIN = VALUE_RANGES.BLOOD_PRESSURE_DIA.min;

/** The statement as it stood before the window: a pick joined back. */
function legacyBloodPressureSeriesSql(rank: string): string {
  return `
    SELECT m."id", m."type"::text AS type, m."source"::text AS source,
           m."value", m."measured_at"
    FROM measurements m
    JOIN (
      SELECT DISTINCT ON (date_trunc('day', "measured_at"))
        date_trunc('day', "measured_at") AS d,
        "source"                         AS canon
      FROM measurements
      WHERE "user_id" = $1
        AND "type" = 'BLOOD_PRESSURE_SYS'::"measurement_type"
        AND "deleted_at" IS NULL
        AND "value" >= $3
        AND "measured_at" >= date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC')
      ORDER BY date_trunc('day', "measured_at"), (${rank}), "source"::text
    ) c
      ON c.d = date_trunc('day', m."measured_at")
      AND c.canon = m."source"
    WHERE m."user_id" = $1
      AND m."deleted_at" IS NULL
      AND m."measured_at" >= $2
      AND (
        (m."type" = 'BLOOD_PRESSURE_SYS'::"measurement_type" AND m."value" >= $3)
        OR (m."type" = 'BLOOD_PRESSURE_DIA'::"measurement_type" AND m."value" >= $4)
      )
    ORDER BY m."measured_at" ASC, m."id" ASC
  `;
}

/** Small seeded generator, so the fixture is the same on every run. */
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

const SOURCES: MeasurementSource[] = [
  "WITHINGS",
  "APPLE_HEALTH",
  "MANUAL",
  // Off the blood-pressure ladder: rank alike, the name tiebreak decides.
  "OURA",
  "WHOOP",
];

const NOW = Date.now();
const TODAY_UTC = Math.floor(NOW / DAY_MS) * DAY_MS;

type Row = {
  userId: string;
  type: "BLOOD_PRESSURE_SYS" | "BLOOD_PRESSURE_DIA";
  source: MeasurementSource;
  value: number;
  unit: string;
  measuredAt: Date;
  deletedAt: Date | null;
};

async function seed(): Promise<number> {
  const prisma = getPrismaClient();
  await makeUser({ id: USER_ID, timezone: "Europe/Berlin" });
  const random = rng(7);
  const rows: Row[] = [];
  const push = (
    type: Row["type"],
    source: MeasurementSource,
    value: number,
    at: number,
  ) =>
    rows.push({
      userId: USER_ID,
      type,
      source,
      value,
      unit: "mmHg",
      measuredAt: new Date(at),
      // A tombstone, sometimes the only row its source had that day.
      deletedAt: random() < 0.06 ? new Date() : null,
    });
  // 400 days: over both DST changes in the user's zone.
  for (let day = 0; day < 400; day++) {
    if (day % 13 === 6) continue; // an empty day
    const dayStart = TODAY_UTC - day * DAY_MS;
    const sources = [...SOURCES]
      .sort(() => random() - 0.5)
      .slice(0, 1 + Math.floor(random() * 3));
    for (const source of sources) {
      const readings = 1 + Math.floor(random() * 3);
      for (let r = 0; r < readings; r++) {
        // Mostly through the day, sometimes a minute either side of UTC
        // midnight.
        const at =
          dayStart +
          (r === 0 && random() < 0.25
            ? random() < 0.5
              ? 60_000
              : DAY_MS - 60_000
            : Math.floor(random() * DAY_MS));
        const shape = random();
        if (shape < 0.08) {
          // A systolic below the floor: it must not claim the day.
          push(
            "BLOOD_PRESSURE_SYS",
            source,
            Math.floor(random() * SYS_MIN),
            at,
          );
          push("BLOOD_PRESSURE_DIA", source, 80, at);
        } else if (shape < 0.14) {
          // A diastolic below its floor.
          push("BLOOD_PRESSURE_SYS", source, 125, at);
          push(
            "BLOOD_PRESSURE_DIA",
            source,
            Math.floor(random() * DIA_MIN),
            at,
          );
        } else if (shape < 0.2) {
          // A diastolic alone: it never picks a source.
          push("BLOOD_PRESSURE_DIA", source, 78, at);
        } else if (shape < 0.25) {
          // A systolic alone.
          push("BLOOD_PRESSURE_SYS", source, 131, at);
        } else {
          const sys = 100 + Math.round(random() * 600) / 10;
          push("BLOOD_PRESSURE_SYS", source, sys, at);
          push(
            "BLOOD_PRESSURE_DIA",
            source,
            60 + Math.round(random() * 300) / 10,
            at + Math.floor(random() * 4) * 60_000,
          );
        }
      }
    }
  }
  // The natural identity is unique; drop accidental collisions.
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = `${row.type}|${row.source}|${row.measuredAt.getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await prisma.measurement.createMany({ data: unique });
  return unique.length;
}

const LADDERS: Array<[string, unknown]> = [
  ["default ladder", null],
  [
    "a user ladder that reorders it",
    { bloodPressure: ["MANUAL", "APPLE_HEALTH", "WITHINGS"] },
  ],
];

const STARTS: Array<[string, Date]> = [
  ["ten years", new Date(NOW - 3650 * DAY_MS)],
  ["a year, mid-day", new Date(TODAY_UTC - 365 * DAY_MS + 13 * 3_600_000)],
  ["thirty days, on UTC midnight", new Date(TODAY_UTC - 30 * DAY_MS)],
  [
    "a week, a minute before UTC midnight",
    new Date(TODAY_UTC - 7 * DAY_MS - 60_000),
  ],
  [
    "a week, a minute after UTC midnight",
    new Date(TODAY_UTC - 7 * DAY_MS + 60_000),
  ],
  // 22:00 UTC is Berlin midnight in summer, 23:00 in winter.
  [
    "ninety days, on a local midnight",
    new Date(TODAY_UTC - 91 * DAY_MS + 22 * 3_600_000),
  ],
  ["two days, mid-day", new Date(TODAY_UTC - 2 * DAY_MS + 9 * 3_600_000)],
];

const ZONES = [
  "UTC",
  "Europe/Berlin",
  "Pacific/Auckland",
  "America/Los_Angeles",
];

describe("blood-pressure series pick parity", () => {
  let seeded = 0;
  beforeAll(async () => {
    await truncateAllTables(getPrismaClient());
    seeded = await seed();
  });

  it("seeds a fixture worth comparing", () => {
    expect(seeded).toBeGreaterThan(2000);
  });

  for (const [ladderLabel, ladder] of LADDERS) {
    for (const zone of ZONES) {
      for (const [startLabel, since] of STARTS) {
        it(`returns the same rows: ${ladderLabel}, ${zone} session, ${startLabel}`, async () => {
          const prisma = getPrismaClient();
          const rank = buildSourceRankCase(ladder, '"type"', '"source"');
          const select = (sql: string) =>
            prisma.$transaction(async (tx) => {
              await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
              return tx.$queryRawUnsafe<
                Array<{
                  id: string;
                  type: string;
                  source: string;
                  value: number;
                  measured_at: Date;
                }>
              >(sql, USER_ID, since, SYS_MIN, DIA_MIN);
            });
          const now = await select(bloodPressureSeriesSql(rank));
          const before = await select(legacyBloodPressureSeriesSql(rank));
          expect(now.length).toBeGreaterThan(0);
          expect(now).toEqual(before);
          // Not trivial: both halves came back, from more than one source
          // over the window, and the pick dropped rows that were live,
          // floor-passing and inside the window.
          expect(new Set(now.map((r) => r.type)).size).toBe(2);
          const live = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
            `SELECT COUNT(*)::int AS n FROM measurements
              WHERE "user_id" = $1 AND "deleted_at" IS NULL
                AND "measured_at" >= $2
                AND (("type" = 'BLOOD_PRESSURE_SYS' AND "value" >= $3)
                  OR ("type" = 'BLOOD_PRESSURE_DIA' AND "value" >= $4))`,
            USER_ID,
            since,
            SYS_MIN,
            DIA_MIN,
          );
          expect(now.length).toBeLessThan(live[0].n);
          if (since.getTime() < TODAY_UTC - 30 * DAY_MS) {
            expect(new Set(now.map((r) => r.source)).size).toBeGreaterThan(1);
          }
        });
      }
    }
  }
});
