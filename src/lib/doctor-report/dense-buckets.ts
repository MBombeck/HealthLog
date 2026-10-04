/**
 * The per-local-day pre-aggregation for the sample-dense measurement types.
 *
 * On a long window a CGM or a per-sample heart-rate account produces six
 * figures of rows, so the dense types (glucose, pulse, heart-rate variability,
 * blood oxygen) collapse to one row per local day/source/device/context in
 * SQL and the canonical-source picker then works over that bounded
 * intermediate set. Every other type keeps the raw-row path.
 *
 * Extracted from the aggregator with the selection rework: the query is a job
 * of its own, it is the one raw-SQL surface on this path, and keeping it in a
 * thousand-line function is how a parameter stops being reviewed.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isHourlyMeanTypeSql } from "@/lib/measurements/day-mean";
import type {
  GlucoseContext,
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";

/** One pre-aggregated bucket: a local day for one type/source/device/context. */
export interface DenseMeasurementBucket {
  bucketStart: Date;
  type: MeasurementType;
  source: MeasurementSource;
  deviceType: string | null;
  glucoseContext: GlucoseContext | null;
  count: number;
  sumValue: number;
  minValue: number;
  maxValue: number;
  latestAt: Date;
  latestValue: number;
  clinicalCount: number;
  clinicalSum: number | null;
  clinicalSumSquares: number | null;
  clinicalFirstAt: Date | null;
  clinicalLastAt: Date | null;
  clinicalTirCount: number;
  clinicalTbr1Count: number;
  clinicalTbr2Count: number;
  clinicalTar1Count: number;
  clinicalTar2Count: number;
  clinicalLowRiskSum: number | null;
  clinicalHighRiskSum: number | null;
  /**
   * For an hourly-mean type (pulse, see `day-mean.ts`): the sum of the
   * bucket's local hours' means and the number of those hours, so the day
   * value is their ratio. `null` for every other type.
   */
  hourMeanSum: number | null;
  hourCount: number | null;
}

/**
 * Load the dense buckets for the types the caller names. An empty list is not
 * a call: nothing is read.
 *
 * Every value is bound as a tagged-template parameter — no splice, no
 * interpolation of anything that came off the wire.
 */
export async function loadDenseMeasurementBuckets(params: {
  userId: string;
  start: Date;
  end: Date;
  reportTz: string;
  denseTypes: readonly MeasurementType[];
}): Promise<DenseMeasurementBucket[]> {
  const { userId, start, end, reportTz, denseTypes } = params;
  if (denseTypes.length === 0) return [];
  const typeList = Prisma.join(
    denseTypes.map((type) => Prisma.sql`${type}::"measurement_type"`),
  );
  // Closed code constant (the hourly-mean type list), spliced as literals.
  const hourlyMeanType = Prisma.raw(isHourlyMeanTypeSql('"type"'));
  return prisma.$queryRaw<DenseMeasurementBucket[]>`
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
        -- The hourly-mean day (pulse): each local hour's mean, then their sum
        -- and count per bucket. Empty for every other type.
        hour_means AS (
          SELECT
            local_day,
            "type",
            "source",
            "device_type",
            "glucose_context",
            AVG("value") AS hour_mean
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
            SUM(hour_mean)::double precision AS hour_mean_sum,
            COUNT(*)::int AS hour_count
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
          hour_agg.hour_mean_sum AS "hourMeanSum",
          hour_agg.hour_count AS "hourCount"
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
