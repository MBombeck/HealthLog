/**
 * Whether the DAY rollup tier can stand in for a type's live readings from a
 * UTC midnight on, decided at the two ends of the range so the check reads
 * days, not the history. Shared by the all-time figures
 * (`readAllTimeExtremes`) and the reading counts (`live-counts.ts`); a middle
 * day a failed recompute left behind is the nightly audit's to find
 * (`rollup-audit.ts`).
 */
import { prisma } from "@/lib/db";
import { Prisma, type MeasurementType } from "@/generated/prisma/client";
import { liveTypeDescent } from "@/lib/measurements/live-type-descent";

/**
 * The types the DAY tier may answer for from `tierFrom` on: those it matches
 * at their ends (the reason for each end is in `readAllTimeExtremes`, `feature-blocks.ts`). Each type is one descent of the live
 * index to its oldest and its newest reading from `tierFrom` on
 * (`liveTypeDescent`, so the plan does not follow the statistics), a
 * count of the readings on those two days, and the type's DAY rows from
 * `tierFrom` on, which are days, not readings. A type with no live
 * reading in the range drops out here and is read raw, which is how a
 * tier that outlived every row of a type is never repeated.
 */
export async function readTierCoveredTypes(
  userId: string,
  types: readonly MeasurementType[],
  tierFrom: Date,
): Promise<Array<{ type: string }>> {
  return prisma.$queryRaw<Array<{ type: string }>>`
    SELECT mt."type" AS type
    FROM unnest(${[...types]}::text[]) AS mt("type")
    CROSS JOIN LATERAL (
      SELECT m."measured_at" AS at
      FROM measurements m
      ${liveTypeDescent(userId, Prisma.sql`mt."type"::measurement_type`, "oldest", tierFrom)}
      LIMIT 1
    ) oldest
    CROSS JOIN LATERAL (
      SELECT m."measured_at" AS at
      FROM measurements m
      ${liveTypeDescent(userId, Prisma.sql`mt."type"::measurement_type`, "newest", tierFrom)}
      LIMIT 1
    ) newest
    CROSS JOIN LATERAL (
      SELECT date_trunc('day', oldest.at) AS first_day,
             date_trunc('day', newest.at) AS last_day
    ) ends
    CROSS JOIN LATERAL (
      SELECT MIN(r."bucket_start") AS first_bucket,
             MAX(r."bucket_start") AS last_bucket,
             bool_and(
               r."reading_min_value" IS NOT NULL
               AND r."reading_max_value" IS NOT NULL
             ) AS complete,
             COALESCE(SUM(r."count") FILTER (
               WHERE r."bucket_start" = ends.first_day AT TIME ZONE 'UTC'
             ), 0)::bigint AS first_count,
             COALESCE(SUM(r."count") FILTER (
               WHERE r."bucket_start" = ends.last_day AT TIME ZONE 'UTC'
             ), 0)::bigint AS last_count
      FROM measurement_rollups r
      WHERE r."user_id" = ${userId}
        AND r."type" = mt."type"::measurement_type
        AND r."granularity" = 'DAY'
        AND r."bucket_start" >= ${tierFrom}
    ) tier
    CROSS JOIN LATERAL (
      SELECT
        (SELECT COUNT(*) FROM measurements m
          WHERE m."user_id" = (SELECT ${userId}::text)
            AND m."type" >= mt."type"::measurement_type
            AND m."type" <= mt."type"::measurement_type
            AND m."deleted_at" IS NULL
            AND m."measured_at" >= ends.first_day
            AND m."measured_at" < ends.first_day + interval '1 day'
        )::bigint AS first_count,
        (SELECT COUNT(*) FROM measurements m
          WHERE m."user_id" = (SELECT ${userId}::text)
            AND m."type" >= mt."type"::measurement_type
            AND m."type" <= mt."type"::measurement_type
            AND m."deleted_at" IS NULL
            AND m."measured_at" >= ends.last_day
            AND m."measured_at" < ends.last_day + interval '1 day'
        )::bigint AS last_count
    ) live
    WHERE tier.complete
      AND tier.first_bucket = ends.first_day AT TIME ZONE 'UTC'
      AND tier.last_bucket = ends.last_day AT TIME ZONE 'UTC'
      AND tier.first_count = live.first_count
      AND tier.last_count = live.last_count
  `;
}
