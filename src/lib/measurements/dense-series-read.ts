/**
 * The long-window read of a sample-dense series (pulse, CGM glucose, and the
 * other dense kinds of `/api/measurements/series`): day or hour buckets in
 * the account's zone, and the strip's figures over the raw readings.
 *
 * Both used to be separate statements over the same canonical rows, so a
 * ten-year pulse read picked the canonical source per day and scanned the
 * readings twice. Now the window's rows are materialised once (`src`) and
 * both aggregates run over them in one statement, with exactly the SQL they
 * had: `tests/integration/dense-series-read-parity.test.ts` holds the two old
 * statements as the reference.
 *
 * Buckets: a day of a type with an activity-dependent sampling rate (pulse)
 * is the weighted mean of its local hours' means, so a workout hour with
 * hundreds of times the readings does not outweigh the rest of the day (see
 * `day-statistic.ts`); the hour grain is already one mean per hour.
 *
 * Figures: aggregated over the raw rows, not the buckets, so the strip's
 * mean, min, max, spread and count are what the raw path computes (`AVG`,
 * `MIN`, `MAX`, `STDDEV_POP`, the exact row count). For an hourly-mean type
 * the mean is the mean of the local days' values, each day the mean of its
 * local hours' means, so it is the mean of the day points the chart draws;
 * count, min, max and the spread stay over every reading.
 *
 * Parameters: `$1` the user (inside `seriesRows`), `$2` the grain, `$3` the
 * zone, `$4` the window start; `seriesRows` is the FROM-clause subquery of
 * `seriesRowsFrom`, its literals whitelisted there.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  dayWeightedRows,
  hourWeightSql,
  weightedHourMeanSql,
  windowMeanSql,
  zoneDayFrame,
} from "@/lib/measurements/day-mean";
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

/** The bucket aggregate over `src`, in the original statement's SQL. */
export function denseBucketsSql(hourWeighted: boolean, from: string): string {
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
export function denseFiguresSql(hourlyMean: boolean): string {
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

/** Buckets and figures of one dense series window, in one statement. */
export async function readDenseSeries(args: {
  userId: string;
  type: MeasurementType;
  grain: "day" | "hour";
  userTz: string;
  since: Date;
  seriesRows: string;
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
      WITH src AS MATERIALIZED (
        SELECT m.*
        FROM ${args.seriesRows}
        WHERE m."measured_at" >= $4
      ),
      buckets AS (${denseBucketsSql(hourWeighted, "src m")}
      ),
      figures AS (${denseFiguresSql(usesHourlyMeanDay(args.type))}
      )
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
