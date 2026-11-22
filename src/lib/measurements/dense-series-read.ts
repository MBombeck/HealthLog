/**
 * The long-window read of a sample-dense series (pulse, CGM glucose, and the
 * other dense kinds of `/api/measurements/series`): day or hour buckets in
 * the account's zone, and the strip's figures over the raw readings.
 *
 * One statement. The window's readings are folded first into cells, one per
 * (source, UTC hour, local hour, value, band) with the readings' count (a
 * hash aggregate: a dense pulse day of 35 000 readings is a few hundred
 * cells), the ladder-canonical source of each UTC day is picked over the
 * cells, and both aggregates run over the canonical cells. The pick sees the
 * same sources per day as a pick over the rows, so it names the same one.
 * It used to rank every raw reading with a window function, which on a dense
 * stream sorted a million rows for a 30-day chart and took seconds on every
 * request. `tests/integration/dense-series-read-parity.test.ts` holds the
 * statements over the raw rows as the reference.
 *
 * Buckets: a day of a type with an activity-dependent sampling rate (pulse)
 * is the weighted mean of its local hours' means, so a workout hour with
 * hundreds of times the readings does not outweigh the rest of the day (see
 * `day-statistic.ts`); the hour grain is already one mean per hour.
 *
 * Figures: over every reading, not the buckets, so the strip's mean, min,
 * max, spread and count are what the raw path computes (`AVG`, `MIN`, `MAX`,
 * the population standard deviation, the exact count). For an hourly-mean
 * type the mean is the mean of the local days' values, each day the mean of
 * its local hours' means, so it is the mean of the day points the chart
 * draws; count, min, max and the spread stay over every reading.
 *
 * Parameters: `$1` the user, `$2` the grain, `$3` the zone, `$4` the window
 * start. The type and the rank CASE are closed-enum splices.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import {
  RANKED_TYPES,
  buildSourceRankCase,
} from "@/lib/analytics/source-rank-sql";
import { prisma } from "@/lib/db";
import { hourWeightSql } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";

export interface DenseBucketRow {
  bucket_start: Date;
  mean: number;
  min_value: number;
  max_value: number;
}

export interface DenseFigures {
  n: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  sd: number | null;
}

const ENUM_RE = /^[A-Z0-9_]+$/;

/** The local wall-clock time of a naive UTC instant in the zone `$3`. */
const local = (column: string) =>
  `((${column} AT TIME ZONE 'UTC') AT TIME ZONE $3)`;

/**
 * The canonical cells of the window: `src`, one row per (source, UTC hour,
 * local hour, value, band) of the day's picked source with its count `n`.
 * A type with a ladder is picked per UTC day from all of the readings of the
 * window's first day; a type without one keeps every source, as the series
 * always has.
 */
export function denseCellsSql(
  type: MeasurementType,
  priorityJson: unknown,
): string {
  if (!ENUM_RE.test(type)) {
    throw new Error(`unsafe enum literal for SQL splice: ${type}`);
  }
  const ranked = RANKED_TYPES.includes(type);
  const cells = `
      SELECT mm."type", mm."source",
        date_trunc('hour', mm."measured_at")                  AS utc_hour,
        -- The profile zone's wall clock, as the series always read it.
        date_trunc('hour', (mm."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE $3) AS local_hour,
        MIN(mm."measured_at")                                 AS first_at,
        (mm."measured_at" >= $4)                              AS inside,
        mm."value", mm."value_min", mm."value_max",
        COUNT(*)::int                                         AS n
      FROM measurements mm
      WHERE mm."user_id" = $1
        AND mm."type" = '${type}'::"measurement_type"
        AND mm."deleted_at" IS NULL
        AND mm."measured_at" >= ${ranked ? `$4::timestamp - INTERVAL '1 day'` : "$4"}
      GROUP BY 1, 2, 3, 4, 6, 7, 8, 9`;
  if (!ranked) {
    return `cells AS (${cells}
      ),
      src AS MATERIALIZED (SELECT c.* FROM cells c)`;
  }
  const rank = buildSourceRankCase(priorityJson, '"type"', '"source"');
  return `cells AS (${cells}
      ),
      src AS MATERIALIZED (
        SELECT p.*
        FROM (
          SELECT c.*,
            FIRST_VALUE(c."source") OVER (
              PARTITION BY date_trunc('day', c.utc_hour)
              ORDER BY (${rank}), c."source"::text
            ) AS pick
          FROM cells c
        ) p
        WHERE p."source" = p.pick AND p.inside
      )`;
}

function bucketsSql(hourWeighted: boolean): string {
  return hourWeighted
    ? `
      hourly AS (
        SELECT
          date_trunc($2, c.local_hour)                              AS local_day,
          SUM(c."value" * c.n) / SUM(c.n)                           AS hour_mean,
          SUM(c.n)                                                  AS n,
          MIN(COALESCE(c."value_min", c."value"))                   AS min_value,
          MAX(COALESCE(c."value_max", c."value"))                   AS max_value
        FROM src c
        GROUP BY c.local_hour
      ),
      buckets AS (
        SELECT
          local_day AT TIME ZONE $3                                 AS bucket_start,
          (SUM(hour_mean * ${hourWeightSql("n")}) / NULLIF(SUM(${hourWeightSql("n")}), 0))::double precision AS mean,
          MIN(min_value)::double precision                          AS min_value,
          MAX(max_value)::double precision                          AS max_value
        FROM hourly
        GROUP BY local_day
      )`
    : `
      buckets AS (
        SELECT
          -- An hour bucket starts at the reading's instant less its minutes
          -- and seconds on the local clock, which every reading of a cell
          -- shares. Truncating the local wall clock instead merged the two
          -- hours a fall-back night repeats into one bucket.
          (CASE
            WHEN $2 = 'hour' THEN (
              c.first_at - (${local("c.first_at")} - date_trunc('hour', ${local("c.first_at")}))
            ) AT TIME ZONE 'UTC'
            ELSE date_trunc($2, c.local_hour) AT TIME ZONE $3
          END)                                                       AS bucket_start,
          (SUM(c."value" * c.n) / SUM(c.n))::double precision        AS mean,
          MIN(COALESCE(c."value_min", c."value"))::double precision  AS min_value,
          MAX(COALESCE(c."value_max", c."value"))::double precision  AS max_value
        FROM src c
        GROUP BY 1
      )`;
}

function figuresSql(hourlyMean: boolean): string {
  // The spread in two passes over the cells: the mean of every reading, then
  // the mean square distance from it.
  const spread = `
      spread AS (
        SELECT c.*, SUM(c."value" * c.n) OVER () / SUM(c.n) OVER () AS all_mean
        FROM src c
      )`;
  if (!hourlyMean) {
    return `${spread},
      figures AS (
        SELECT
          COALESCE(SUM(c.n), 0)::int                                   AS n,
          (SUM(c."value" * c.n) / SUM(c.n))::double precision          AS mean,
          MIN(c."value")::double precision                             AS min,
          MAX(c."value")::double precision                             AS max,
          SQRT(SUM(c.n * (c."value" - c.all_mean) ^ 2) / SUM(c.n))::double precision AS sd
        FROM spread c
      )`;
  }
  // A reading weighs its local hour's weight shared among the hour's
  // readings, divided by the day's total hour weight (`day-mean.ts`).
  return `${spread},
      hours AS (
        SELECT c.*,
          SUM(c.n) OVER (PARTITION BY c.local_hour)                      AS hour_n,
          (ROW_NUMBER() OVER (PARTITION BY c.local_hour) = 1)::int       AS hour_first
        FROM spread c
      ),
      weighted AS (
        SELECT h.*,
          (${hourWeightSql("h.hour_n")} / (h.hour_n * SUM(h.hour_first * ${hourWeightSql("h.hour_n")}) OVER (PARTITION BY date_trunc('day', h.local_hour))))::double precision AS day_weight
        FROM hours h
      ),
      figures AS (
        SELECT
          SUM(c.n)::int                                                AS n,
          (SUM(c."value" * c.n * c.day_weight) / NULLIF(SUM(c.n * c.day_weight), 0))::double precision AS mean,
          MIN(c."value")::double precision                             AS min,
          MAX(c."value")::double precision                             AS max,
          SQRT(SUM(c.n * (c."value" - c.all_mean) ^ 2) / SUM(c.n))::double precision AS sd
        FROM weighted c
        HAVING COUNT(*) > 0
      )`;
}

/** Buckets and figures of one dense series window, in one statement. */
export async function readDenseSeries(args: {
  userId: string;
  type: MeasurementType;
  grain: "day" | "hour";
  userTz: string;
  since: Date;
  priorityJson: unknown;
}): Promise<{
  bucketRows: DenseBucketRow[];
  rawAgg: DenseFigures | undefined;
}> {
  const hourWeighted = args.grain === "day" && usesHourlyMeanDay(args.type);
  const rows = await prisma.$queryRawUnsafe<
    Array<
      { kind: "bucket" | "figures" } & Partial<DenseBucketRow> &
        Partial<DenseFigures>
    >
  >(
    `
      WITH ${denseCellsSql(args.type, args.priorityJson)},
      ${bucketsSql(hourWeighted)},
      ${figuresSql(usesHourlyMeanDay(args.type))}
      SELECT 'bucket' AS kind, b.bucket_start, b.mean, b.min_value, b.max_value,
             NULL::int AS n, NULL::double precision AS min,
             NULL::double precision AS max, NULL::double precision AS sd
      FROM buckets b
      UNION ALL
      SELECT 'figures', NULL, f.mean, NULL, NULL, f.n, f.min, f.max, f.sd
      FROM figures f
      ORDER BY kind ASC, bucket_start ASC
    `,
    args.userId,
    args.grain,
    args.userTz,
    args.since,
  );
  const bucketRows: DenseBucketRow[] = [];
  let rawAgg: DenseFigures | undefined;
  for (const row of rows) {
    if (row.kind === "bucket") {
      bucketRows.push({
        bucket_start: row.bucket_start!,
        mean: row.mean!,
        min_value: row.min_value!,
        max_value: row.max_value!,
      });
    } else {
      rawAgg = {
        n: row.n!,
        mean: row.mean ?? null,
        min: row.min ?? null,
        max: row.max ?? null,
        sd: row.sd ?? null,
      };
    }
  }
  return { bucketRows, rawAgg };
}
