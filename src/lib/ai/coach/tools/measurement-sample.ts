/**
 * The newest readings of each measurement type, aggregated per unit: the
 * bounded read under the Coach availability probe (`availability.ts`).
 *
 * Each type is read newest first through its own descent of the live index
 * (`liveTypeDescent`, so the plan does not follow the statistics), stopping
 * one row past `MEASUREMENT_SAMPLE_CAP`, and its oldest reading is one more
 * descent. A type with no more rows than the cap is therefore aggregated over
 * its whole history (from `floor` on); a type with more is a device stream,
 * and the caller takes its figures from the rollup tier instead. The mean is
 * the day-weighted one for an hourly-mean type (`day-mean.ts`), the plain
 * mean otherwise.
 */
import { prisma } from "@/lib/db";
import { Prisma, type MeasurementType } from "@/generated/prisma/client";
import { dayWeightedRowsSql, windowMeanSql } from "@/lib/measurements/day-mean";
import { liveTypeDescent } from "@/lib/measurements/live-type-descent";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/** Rows a type is aggregated from directly before it counts as a stream. */
export const MEASUREMENT_SAMPLE_CAP = 5_000;

/** One type and unit of the sample, with the type's oldest reading. */
export interface MeasurementSampleRow {
  type: string;
  unit: string | null;
  /** Sampled rows of this type and unit (the type's total tells capping). */
  n: number;
  first_at: Date;
  last_at: Date;
  min: number | null;
  max: number | null;
  mean: number | null;
  oldest_at: Date | null;
  oldest_unit: string | null;
}

export async function readMeasurementSample(
  userId: string,
  types: readonly MeasurementType[],
  floor: Date | null,
): Promise<MeasurementSampleRow[]> {
  const tz = await resolveUserTimezone(userId);
  const type = Prisma.sql`mt."type"::measurement_type`;
  return prisma.$queryRaw<MeasurementSampleRow[]>`
    WITH src AS (
      SELECT mt."type"::measurement_type AS "type", x."unit", x."value",
             x."measured_at"
      FROM unnest(${[...types]}::text[]) AS mt("type")
      CROSS JOIN LATERAL (
        SELECT m."unit", m."value", m."measured_at"
        FROM measurements m
        ${liveTypeDescent(userId, type, "newest", floor)}
        LIMIT (SELECT ${MEASUREMENT_SAMPLE_CAP + 1}::int)
      ) x
    ),
    sampled AS (
      SELECT
        m."type"::text AS type,
        m."unit" AS unit,
        COUNT(*)::int AS n,
        MIN(m."measured_at") AS first_at,
        MAX(m."measured_at") AS last_at,
        MIN(m."value")::double precision AS min,
        MAX(m."value")::double precision AS max,
        ${Prisma.raw(
          windowMeanSql({
            typeColumn: 'm."type"',
            value: 'm."value"',
            weight: "m.day_weight",
          }),
        )}::double precision AS mean
      FROM ${dayWeightedRowsSql("src", tz)} m
      GROUP BY m."type", m."unit"
    )
    SELECT s.*, o."measured_at" AS oldest_at, o."unit" AS oldest_unit
    FROM sampled s
    CROSS JOIN LATERAL (
      SELECT m."measured_at", m."unit"
      FROM measurements m
      ${liveTypeDescent(userId, Prisma.sql`s."type"::measurement_type`, "oldest", floor)}
      LIMIT 1
    ) o
  `;
}
