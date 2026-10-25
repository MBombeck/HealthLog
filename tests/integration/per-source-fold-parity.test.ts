/**
 * Three per-source folds, against a real Postgres: each reader as it ships
 * (one fold over one scan) against the statement it replaced, kept verbatim
 * below as the reference, in which a second grouping of the same rows was
 * joined back to the per-source days or buckets.
 *
 *   - `readLiveBuckets`: the local hours' means for an hourly-mean type,
 *     joined to the per-source days before the ladder pick;
 *   - `readAllTimeExtremes`: the day-weighted sums for an hourly-mean type,
 *     joined to the per-source days before the ladder pick;
 *   - `loadDenseMeasurementBuckets`: each bucket's latest reading and its
 *     hour means, joined to the bucket aggregates.
 *
 * Every row must match: keys, counts, timestamps and extremes exactly, sums
 * and means to within floating-point summation order (each statement adds
 * the same readings, but not always in the same order or grouping, and
 * neither statement fixed that order). The fixture carries what could tell
 * them apart: overlapping sources per day, a source off every ladder, a
 * cumulative type, an hourly-mean type with several readings in one hour,
 * glucose contexts and device types including null ones, tombstones,
 * readings a minute either side of UTC midnight, both DST changes in the
 * user's zone, and empty days. Shapes run under the default ladders and a
 * user ladder, in zones with whole, half-hour and negative offsets.
 *
 * The fixture holds no rollups, so `readAllTimeExtremes` reads every type
 * from the raw rows; its rollup arm is a separate `UNION ALL` the change did
 * not touch.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  Prisma,
  type GlucoseContext,
  type MeasurementSource,
  type MeasurementType,
} from "@/generated/prisma/client";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { prisma as appPrisma } from "@/lib/db";
import { loadDenseMeasurementBuckets } from "@/lib/doctor-report/dense-buckets";
import { readAllTimeExtremes } from "@/lib/insights/feature-blocks";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { readLiveBuckets } from "@/lib/measurements/daily-series-read";
import {
  dayWeightedRowsSql,
  foldMeanSql,
  hourWeightSql,
  isHourlyMeanTypeSql,
  weightedHourMeanSql,
} from "@/lib/measurements/day-mean";
import { HOURLY_MEAN_DAY_TYPES } from "@/lib/measurements/day-statistic";

import { makeUser } from "../kit/factories";

import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const USER_ID = "user-per-source-fold-parity";
const DAY_MS = 86_400_000;
const NOW = Date.now();
const TODAY_UTC = Math.floor(NOW / DAY_MS) * DAY_MS;

type Row = Record<string, unknown>;

/** The rows each `$queryRaw` the reader issued returned, in call order. */
async function capture(read: () => Promise<unknown>): Promise<Row[][]> {
  const results: Row[][] = [];
  const original = appPrisma.$queryRaw.bind(appPrisma) as (
    ...args: unknown[]
  ) => Promise<Row[]>;
  vi.spyOn(appPrisma, "$queryRaw").mockImplementation(((...args: unknown[]) =>
    original(...args).then((rows) => {
      results.push(rows);
      return rows;
    })) as never);
  await read();
  return results;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Compare two row sets: numbers to a relative 1e-9, everything else exact. */
function expectSameRows(now: Row[], before: Row[], keys: string[]) {
  const key = (r: Row) =>
    keys
      .map((k) =>
        r[k] instanceof Date ? (r[k] as Date).toISOString() : String(r[k]),
      )
      .join("|");
  const sort = (rows: Row[]) =>
    [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const a = sort(now);
  const b = sort(before);
  expect(a.map(key)).toEqual(b.map(key));
  for (let i = 0; i < a.length; i++) {
    expect(Object.keys(a[i]).sort()).toEqual(Object.keys(b[i]).sort());
    for (const [col, value] of Object.entries(a[i])) {
      const other = b[i][col];
      if (typeof value === "number" && typeof other === "number") {
        expect(
          Math.abs(value - other),
          `${col} of ${key(a[i])}: ${value} vs ${other}`,
        ).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(other)));
      } else {
        expect(value, `${col} of ${key(a[i])}`).toEqual(other);
      }
    }
  }
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
  "APPLE_HEALTH",
  "WITHINGS",
  "MANUAL",
  "OURA",
  // Off every ladder: the name tiebreak decides.
  "NIGHTSCOUT",
];
const TYPES: MeasurementType[] = [
  "PULSE",
  "BLOOD_GLUCOSE",
  "HEART_RATE_VARIABILITY",
  "WEIGHT",
  "ACTIVITY_STEPS",
  "BLOOD_PRESSURE_SYS",
];
const CONTEXTS: Array<GlucoseContext | null> = [null, "FASTING", "RANDOM"];
const DEVICES: Array<string | null> = [null, "watch", "phone"];

async function seed(): Promise<number> {
  await makeUser({ id: USER_ID, timezone: "Europe/Berlin" });
  const random = rng(11);
  const rows: Prisma.MeasurementCreateManyInput[] = [];
  // 400 days: over both DST changes in the user's zone.
  for (let day = 0; day < 400; day++) {
    if (day % 17 === 8) continue; // an empty day
    const dayStart = TODAY_UTC - day * DAY_MS;
    for (const type of TYPES) {
      const sources = [...SOURCES]
        .sort(() => random() - 0.5)
        .slice(0, 1 + Math.floor(random() * 3));
      for (const source of sources) {
        const readings = 1 + Math.floor(random() * 6);
        // Several readings share an hour, so an hour mean differs from a
        // reading mean.
        const hour = Math.floor(random() * 24);
        for (let r = 0; r < readings; r++) {
          const offset =
            r === 0 && random() < 0.2
              ? random() < 0.5
                ? 60_000
                : DAY_MS - 60_000
              : random() < 0.5
                ? hour * 3_600_000 + Math.floor(random() * 3_600_000)
                : Math.floor(random() * DAY_MS);
          rows.push({
            userId: USER_ID,
            type,
            source,
            value: Math.round(random() * 2_000_000) / 10_000 + 1,
            unit: "x",
            measuredAt: new Date(dayStart + offset),
            deviceType: DEVICES[Math.floor(random() * DEVICES.length)],
            glucoseContext:
              type === "BLOOD_GLUCOSE"
                ? CONTEXTS[Math.floor(random() * CONTEXTS.length)]
                : null,
            // A tombstone, sometimes the only row its source had that day.
            deletedAt: random() < 0.06 ? new Date() : null,
          });
        }
      }
    }
  }
  // The natural identity is unique; drop accidental collisions.
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = `${row.type}|${row.source}|${(row.measuredAt as Date).getTime()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  await prisma.measurement.createMany({ data: unique });
  return unique.length;
}

const LADDERS: Array<[string, Prisma.InputJsonValue | null]> = [
  ["default ladders", null],
  [
    "a user ladder",
    {
      pulse: ["OURA", "WITHINGS", "APPLE_HEALTH"],
      weight: ["MANUAL", "WITHINGS"],
      steps: ["WITHINGS", "APPLE_HEALTH"],
      bloodPressure: ["APPLE_HEALTH", "MANUAL", "WITHINGS"],
    },
  ],
];
const ZONES = ["Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata"];

async function setLadder(ladder: Prisma.InputJsonValue | null) {
  await prisma.user.update({
    where: { id: USER_ID },
    data: { sourcePriorityJson: ladder ?? Prisma.DbNull },
  });
}

// ---------------------------------------------------------------------------
// The references, verbatim but for their inputs, which the readers build the
// same way.

function legacyLiveBuckets(opts: {
  userId: string;
  type: MeasurementType | null;
  from: Date;
  to: Date;
  cap: number;
  priorityJson: unknown;
  unitName: string;
  timeZone: string;
}) {
  const { userId, type, from, to, cap, priorityJson, timeZone } = opts;
  const unit = Prisma.raw(`'${opts.unitName}'`);
  const cumulativeList = [...CUMULATIVE_HK_TYPES]
    .map((t) => `'${t}'`)
    .join(",");
  const isCumulative = Prisma.raw(`c."type"::text IN (${cumulativeList})`);
  const hourlyMeanList = Prisma.raw(
    [...HOURLY_MEAN_DAY_TYPES].map((t) => `'${t}'::measurement_type`).join(","),
  );
  const rankRaw = Prisma.raw(
    buildSourceRankCase(priorityJson, 'p."type"', 'p."source"'),
  );
  const dayOfHours = Prisma.raw(
    weightedHourMeanSql("h.hour_mean", hourWeightSql("h.n")),
  );
  const typeFilter = type
    ? Prisma.sql`AND m."type" = ${type}::measurement_type`
    : Prisma.empty;
  return prisma.$queryRaw<Row[]>`
    WITH per_source AS (
      SELECT
        m."type",
        m."source",
        date_trunc('day', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}) AS day,
        SUM(m."value")::double precision AS total,
        COUNT(*)::int AS cnt,
        MIN(m."value") AS min_value,
        MAX(m."value") AS max_value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${from}
        AND m."measured_at" <= ${to}
        AND m."deleted_at" IS NULL
        ${typeFilter}
      GROUP BY m."type", m."source", 3
    ),
    -- A day of a type with an activity-dependent sampling rate is the weighted
    -- mean of its local hours' means, not the mean of its readings: a workout
    -- hour holds hundreds of times as many readings as a resting one.
    -- Empty for every other type.
    hour_mean AS (
      SELECT h."type", h."source", h.day,
             ${dayOfHours}::double precision AS day_mean
      FROM (
        SELECT
          m."type",
          m."source",
          date_trunc('day', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}) AS day,
          date_trunc('hour', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}) AS hr,
          AVG(m."value") AS hour_mean,
          COUNT(*) AS n
        FROM measurements m
        WHERE m."user_id" = ${userId}
          AND m."measured_at" >= ${from}
          AND m."measured_at" <= ${to}
          AND m."deleted_at" IS NULL
          AND m."type" IN (${hourlyMeanList})
          ${typeFilter}
        GROUP BY m."type", m."source", 3, 4
      ) h
      GROUP BY h."type", h."source", h.day
    ),
    canon AS (
      SELECT DISTINCT ON (p."type", p.day)
        p."type", p.day, p.total, p.cnt, p.min_value, p.max_value, hm.day_mean
      FROM per_source p
      LEFT JOIN hour_mean hm
        ON hm."type" = p."type" AND hm."source" = p."source" AND hm.day = p.day
      ORDER BY p."type", p.day, (${rankRaw}), p."source"::text
    ),
    folded AS (
      SELECT
        c."type",
        date_trunc(${unit}, c.day) AS d,
        (CASE
           WHEN ${isCumulative} THEN SUM(c.total)
           -- Hourly-mean types: every day once, so a window of days does not
           -- hand a workout day its thousands of readings as weight.
           WHEN COUNT(c.day_mean) = COUNT(*) THEN AVG(c.day_mean)
           ELSE SUM(c.total) / SUM(c.cnt)
         END)::double precision AS avg,
        SUM(c.cnt)::int AS cnt,
        MIN(c.min_value) AS min_value,
        MAX(c.max_value) AS max_value
      FROM canon c
      GROUP BY c."type", 2
    )
    SELECT
      f."type"::text AS type,
      f.d AT TIME ZONE ${timeZone} AS bucket_start,
      f.avg,
      f.cnt,
      f.min_value,
      f.max_value
    FROM folded f
    ORDER BY f.d ASC
    LIMIT ${cap}
  `;
}

function legacyAllTimeExtremes(
  userId: string,
  types: readonly MeasurementType[],
  floor: Date | null,
  priorityJson: unknown,
) {
  const typeList = (list: readonly MeasurementType[]) =>
    Prisma.join(list.map((t) => Prisma.sql`${t}::measurement_type`));
  const since =
    floor === null ? Prisma.empty : Prisma.sql`AND m."measured_at" >= ${floor}`;
  // No rollups in the fixture: every type is read raw, in one arm.
  const rawArms = [
    Prisma.sql`
      SELECT m."type", m."source", m."measured_at", m."value"
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."type" IN (${typeList(types)})
        ${since}`,
  ];
  const tierCanon = Prisma.empty;
  const rank = (alias: string) =>
    Prisma.raw(
      buildSourceRankCase(priorityJson, `${alias}."type"`, `${alias}."source"`),
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
  return prisma.$queryRaw<Row[]>`
    WITH live AS (${Prisma.join(rawArms, " UNION ALL ")}),
    hourly_src AS (
      SELECT * FROM live l
      WHERE ${Prisma.raw(isHourlyMeanTypeSql('l."type"'))}
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
        l."type",
        l."source",
        date_trunc('day', l."measured_at") AS day,
        COUNT(*)::int                      AS cnt,
        SUM(l."value")::double precision   AS total,
        MIN(l."value")::double precision   AS min_value,
        MAX(l."value")::double precision   AS max_value
      FROM live l
      GROUP BY l."type", l."source", 3
    )
    SELECT
      c."type"::text                                  AS type,
      ${mean}::double precision                       AS mean,
      MIN(c.min_value)::double precision              AS min,
      MAX(c.max_value)::double precision              AS max
    FROM (
      SELECT * FROM (
        SELECT DISTINCT ON (p."type", p.day)
          p."type", p.cnt, p.total, p.min_value, p.max_value, w.wsum, w.wdays
        FROM per_source p
        LEFT JOIN weighted w
          ON w."type" = p."type" AND w."source" = p."source" AND w.day = p.day
        ORDER BY p."type", p.day, (${rank("p")}), p."source"::text
      ) raw
      ${tierCanon}
    ) c
    GROUP BY c."type"
  `;
}

function legacyDenseBuckets(params: {
  userId: string;
  start: Date;
  end: Date;
  reportTz: string;
  denseTypes: readonly MeasurementType[];
}) {
  const { userId, start, end, reportTz, denseTypes } = params;
  const typeList = Prisma.join(
    denseTypes.map((type) => Prisma.sql`${type}::"measurement_type"`),
  );
  const hourlyMeanType = Prisma.raw(isHourlyMeanTypeSql('"type"'));
  const hourWeight = Prisma.raw(hourWeightSql("n"));
  return prisma.$queryRaw<Row[]>`
        WITH localized AS (
          SELECT
            m."id",
            m."type",
            m."source",
            m."device_type",
            m."glucose_context",
            m."value",
            m."measured_at",
            date_trunc(
              'day',
              (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${reportTz}
            ) AS local_day,
            date_trunc(
              'hour',
              (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${reportTz}
            ) AS local_hour
          FROM measurements m
          WHERE m."user_id" = ${userId}
            AND m."measured_at" >= ${start}
            AND m."measured_at" <= ${end}
            AND m."deleted_at" IS NULL
            AND m."type" IN (${typeList})
        ),
        scored AS (
          SELECT
            localized.*,
            CASE
              WHEN "value" > 0
              THEN 1.509 * (power(ln("value"), 1.084) - 5.381)
              ELSE NULL
            END AS risk_transform
          FROM localized
        ),
        latest_rows AS (
          SELECT DISTINCT ON (
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context"
          )
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context",
            "measured_at" AS latest_at,
            "value" AS latest_value
          FROM localized
          ORDER BY
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context",
            "measured_at" DESC,
            "id" DESC
        ),
        -- The hourly-mean day (pulse): each local hour's mean and reading
        -- count, then the weighted sum of the means and the sum of the hour
        -- weights per bucket. Empty for every other type.
        hour_means AS (
          SELECT
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context",
            AVG("value") AS hour_mean,
            COUNT(*) AS n
          FROM localized
          WHERE ${hourlyMeanType}
          GROUP BY
            local_day,
            local_hour,
            "type",
            "source",
            "device_type",
            "glucose_context"
        ),
        hour_agg AS (
          SELECT
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context",
            SUM(hour_mean * ${hourWeight})::double precision AS hour_weighted_sum,
            SUM(${hourWeight})::double precision AS hour_weight
          FROM hour_means
          GROUP BY
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context"
        ),
        grouped AS (
          SELECT
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context",
            COUNT(*)::int AS sample_count,
            SUM("value")::double precision AS sum_value,
            MIN("value")::double precision AS min_value,
            MAX("value")::double precision AS max_value,
            COUNT(*) FILTER (WHERE "value" > 0)::int AS clinical_count,
            SUM("value") FILTER (WHERE "value" > 0)::double precision
              AS clinical_sum,
            SUM("value" * "value") FILTER (WHERE "value" > 0)::double precision
              AS clinical_sum_squares,
            MIN("measured_at") FILTER (WHERE "value" > 0) AS clinical_first_at,
            MAX("measured_at") FILTER (WHERE "value" > 0) AS clinical_last_at,
            COUNT(*) FILTER (WHERE "value" BETWEEN 70 AND 180)::int
              AS clinical_tir_count,
            COUNT(*) FILTER (WHERE "value" > 0 AND "value" < 70)::int
              AS clinical_tbr1_count,
            COUNT(*) FILTER (WHERE "value" > 0 AND "value" < 54)::int
              AS clinical_tbr2_count,
            COUNT(*) FILTER (WHERE "value" > 180)::int
              AS clinical_tar1_count,
            COUNT(*) FILTER (WHERE "value" > 250)::int
              AS clinical_tar2_count,
            SUM(
              CASE
                WHEN risk_transform < 0
                THEN 10 * risk_transform * risk_transform
                ELSE 0
              END
            ) FILTER (WHERE risk_transform IS NOT NULL)::double precision
              AS clinical_low_risk_sum,
            SUM(
              CASE
                WHEN risk_transform > 0
                THEN 10 * risk_transform * risk_transform
                ELSE 0
              END
            ) FILTER (WHERE risk_transform IS NOT NULL)::double precision
              AS clinical_high_risk_sum
          FROM scored
          GROUP BY
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context"
        )
        SELECT
          grouped.local_day AT TIME ZONE ${reportTz} AS "bucketStart",
          grouped."type",
          grouped."source",
          grouped."device_type" AS "deviceType",
          grouped."glucose_context" AS "glucoseContext",
          grouped.sample_count AS "count",
          grouped.sum_value AS "sumValue",
          grouped.min_value AS "minValue",
          grouped.max_value AS "maxValue",
          latest_rows.latest_at AS "latestAt",
          latest_rows.latest_value::double precision AS "latestValue",
          grouped.clinical_count AS "clinicalCount",
          grouped.clinical_sum AS "clinicalSum",
          grouped.clinical_sum_squares AS "clinicalSumSquares",
          grouped.clinical_first_at AS "clinicalFirstAt",
          grouped.clinical_last_at AS "clinicalLastAt",
          grouped.clinical_tir_count AS "clinicalTirCount",
          grouped.clinical_tbr1_count AS "clinicalTbr1Count",
          grouped.clinical_tbr2_count AS "clinicalTbr2Count",
          grouped.clinical_tar1_count AS "clinicalTar1Count",
          grouped.clinical_tar2_count AS "clinicalTar2Count",
          grouped.clinical_low_risk_sum AS "clinicalLowRiskSum",
          grouped.clinical_high_risk_sum AS "clinicalHighRiskSum",
          hour_agg.hour_weighted_sum AS "hourWeightedSum",
          hour_agg.hour_weight AS "hourWeight"
        FROM grouped
        INNER JOIN latest_rows
          ON latest_rows.local_day = grouped.local_day
          AND latest_rows."type" = grouped."type"
          AND latest_rows."source" = grouped."source"
          AND latest_rows."device_type" IS NOT DISTINCT FROM grouped."device_type"
          AND latest_rows."glucose_context" IS NOT DISTINCT FROM grouped."glucose_context"
        LEFT JOIN hour_agg
          ON hour_agg.local_day = grouped.local_day
          AND hour_agg."type" = grouped."type"
          AND hour_agg."source" = grouped."source"
          AND hour_agg."device_type" IS NOT DISTINCT FROM grouped."device_type"
          AND hour_agg."glucose_context" IS NOT DISTINCT FROM grouped."glucose_context"
        ORDER BY "bucketStart" ASC, grouped."type" ASC

`;
}

// ---------------------------------------------------------------------------

describe("per-source fold parity", () => {
  let seeded = 0;
  beforeAll(async () => {
    await truncateAllTables(prisma);
    seeded = await seed();
  }, 120_000);

  it("seeds a fixture worth comparing", () => {
    expect(seeded).toBeGreaterThan(5000);
  });

  describe("readLiveBuckets", () => {
    const SHAPES: Array<
      [string, MeasurementType | null, "daily" | "weekly" | "monthly", number]
    > = [
      ["every type, daily, 400 days", null, "daily", 400],
      ["every type, weekly, 400 days", null, "weekly", 400],
      ["every type, monthly, 400 days", null, "monthly", 400],
      ["pulse, daily, 30 days", "PULSE", "daily", 30],
      ["steps, weekly, 120 days", "ACTIVITY_STEPS", "weekly", 120],
    ];
    const UNIT = { daily: "day", weekly: "week", monthly: "month" } as const;
    for (const [ladderLabel, ladder] of LADDERS) {
      for (const zone of ZONES) {
        for (const [label, type, grain, days] of SHAPES) {
          it(`returns the same buckets: ${ladderLabel}, ${zone}, ${label}`, async () => {
            await setLadder(ladder);
            // A window edge in the middle of a day.
            const from = new Date(NOW - days * DAY_MS - 5 * 3_600_000);
            const to = new Date(NOW);
            const opts = {
              userId: USER_ID,
              type,
              from,
              to,
              cap: 100_000,
              priorityJson: ladder,
              timeZone: zone,
            };
            const [now] = await capture(() =>
              readLiveBuckets({ ...opts, grain }),
            );
            const before = await legacyLiveBuckets({
              ...opts,
              unitName: UNIT[grain],
            });
            expect(now.length).toBeGreaterThan(0);
            expectSameRows(now, before, ["type", "bucket_start", "cnt"]);
          });
        }
      }
    }
  });

  describe("readAllTimeExtremes", () => {
    const TYPES_READ: MeasurementType[] = [
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "PULSE",
      "ACTIVITY_STEPS",
    ];
    for (const [ladderLabel, ladder] of LADDERS) {
      for (const [floorLabel, floor] of [
        ["all time", null],
        ["from a floor mid-day", new Date(NOW - 90 * DAY_MS - 7 * 3_600_000)],
      ] as const) {
        it(`returns the same figures: ${ladderLabel}, ${floorLabel}`, async () => {
          await setLadder(ladder);
          const results = await capture(() =>
            readAllTimeExtremes(USER_ID, TYPES_READ, floor),
          );
          // The tier check first, then the fold; no type came from the tier.
          expect(results).toHaveLength(2);
          expect(results[0]).toEqual([]);
          const before = await legacyAllTimeExtremes(
            USER_ID,
            TYPES_READ,
            floor,
            ladder,
          );
          expect(results[1]).toHaveLength(TYPES_READ.length);
          expectSameRows(results[1], before, ["type"]);
        });
      }
    }
  });

  describe("loadDenseMeasurementBuckets", () => {
    const DENSE: MeasurementType[] = [
      "PULSE",
      "BLOOD_GLUCOSE",
      "HEART_RATE_VARIABILITY",
    ];
    for (const zone of ZONES) {
      for (const [label, days] of [
        ["400 days", 400],
        ["120 days", 120],
      ] as const) {
        it(`returns the same buckets: ${zone}, ${label}`, async () => {
          const params = {
            userId: USER_ID,
            start: new Date(NOW - days * DAY_MS - 5 * 3_600_000),
            end: new Date(NOW),
            reportTz: zone,
            denseTypes: DENSE,
          };
          const now = (await loadDenseMeasurementBuckets(
            params,
          )) as unknown as Row[];
          const before = await legacyDenseBuckets(params);
          expect(now.length).toBeGreaterThan(0);
          // Some buckets carry an hour fold and some do not.
          expect(now.some((r) => r.hourWeight !== null)).toBe(true);
          expect(now.some((r) => r.hourWeight === null)).toBe(true);
          expectSameRows(now, before, [
            "bucketStart",
            "type",
            "source",
            "deviceType",
            "glucoseContext",
          ]);
        });
      }
    }
  });
});
