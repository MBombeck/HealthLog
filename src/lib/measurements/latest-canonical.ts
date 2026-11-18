import { prisma } from "@/lib/db";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { measurementTypeEnum } from "@/lib/validations/measurement";

export interface LatestCanonicalRow {
  type: string;
  value: number;
  measured_at: Date;
}

/**
 * The latest canonical reading per measurement type: the latest UTC day
 * first, then the source ladder (the canonical source wins), then the latest
 * reading of that source, so a tile's headline matches its chart. `since`
 * drops a type whose latest reading is older than it.
 *
 * Driven from the type list rather than a `DISTINCT ON (type)` over the
 * account: Postgres 16 has no skip scan, so that shape sorted every live row
 * of the account to keep one per type. Here each type costs one probe of
 * `measurements_live_covering_idx` for its latest instant and one read of that
 * single day. The closed day window matters to the planner as much as to the
 * result: with only the lower bound it estimates a third of the type's rows
 * per probe, and the summed estimate crosses `jit_above_cost`, whose
 * compilation then costs more than the query itself.
 *
 * The latest-instant probe is `liveTypeDescent`
 * (`src/lib/measurements/live-type-descent.ts`) written out positionally: the
 * account through a scalar subquery, the type as a closed range it is also
 * ordered on. As a plain equality, an account whose rows arrived after the
 * last ANALYZE had the planner walk the type-less `(user_id, measured_at)`
 * index through every row of the account once per type.
 *
 * The read of that day is written the same way: the day's rows come out of a
 * subquery that descends the live index (account through a scalar subquery,
 * type as a closed range, ordered on type and instant), and only those rows
 * are ranked by source. Ranked in place, the source order left the planner no
 * reason to prefer the live index, and in the same statistics states it read
 * every row of the account to keep one day of one type.
 */
export function readLatestCanonical(
  userId: string,
  priorityJson: unknown,
  since: Date | null = null,
): Promise<LatestCanonicalRow[]> {
  const rank = buildSourceRankCase(
    priorityJson,
    'day_rows."type"',
    'day_rows."source"',
  );
  return prisma.$queryRawUnsafe<LatestCanonicalRow[]>(
    `
    SELECT
      mt."type"::text AS type,
      l.value         AS value,
      l.measured_at   AS measured_at
    FROM unnest($2::"measurement_type"[]) AS mt("type")
    CROSS JOIN LATERAL (
      SELECT date_trunc('day', d."measured_at") AS day
      FROM measurements d
      WHERE d."user_id" = (SELECT $1::text)
        AND d."type" >= mt."type"
        AND d."type" <= mt."type"
        AND d."deleted_at" IS NULL
        ${since ? `AND d."measured_at" >= $3` : ""}
      ORDER BY d."type" ASC, d."measured_at" DESC
      LIMIT 1
    ) last_day
    CROSS JOIN LATERAL (
      SELECT day_rows.value, day_rows.measured_at
      FROM (
        SELECT
          m."value"::double precision AS value,
          m."measured_at"             AS measured_at,
          m."id"                      AS id,
          m."type"                    AS type,
          m."source"                  AS source
        FROM measurements m
        WHERE m."user_id" = (SELECT $1::text)
          AND m."type" >= mt."type"
          AND m."type" <= mt."type"
          AND m."deleted_at" IS NULL
          AND m."measured_at" >= last_day.day
          AND m."measured_at" < last_day.day + INTERVAL '1 day'
        ORDER BY m."type" ASC, m."measured_at" DESC
      ) day_rows
      ORDER BY (${rank}), day_rows.measured_at DESC, day_rows.id DESC
      LIMIT 1
    ) l
    ORDER BY mt."type"
  `,
    ...[userId, measurementTypeEnum.options, ...(since ? [since] : [])],
  );
}
