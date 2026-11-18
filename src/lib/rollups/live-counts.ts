/**
 * How many live readings each type holds from `since` on, counted exactly
 * without reading a dense stream row by row.
 *
 * A reading count is what an MCP client is told a domain holds, so it has to
 * be the true number, and a capped count passed off as one is a false number.
 * Counting the rows themselves is the read a dense account cannot afford: a
 * watch's heart rate over thirty days is a quarter of a million of them.
 *
 * The DAY rollup tier already holds each day's reading count per source, kept
 * by every write, and the sum over its sources is the day's live count. So a
 * type's count is, read-swap style:
 *
 *   - the live rows before `tierFrom`, the first whole UTC day the tier may
 *     answer for (the part of the first day `since` cuts, or, for a count of
 *     the whole history, the rows older than the five-year fold window);
 *   - from `tierFrom` on, the tier's counts summed, when the tier matches the
 *     record at both ends (`readTierCoveredTypes`), and the live rows counted
 *     otherwise, the coverage miss the tier cannot answer.
 *
 * For a window, the live part is at most a day per type, plus the two days
 * the coverage check counts. A count of the whole history adds the readings
 * older than the fold window, which the tier never holds, from a closed
 * block cached per account (`readPreTierCounts`).
 */
import { prisma } from "@/lib/db";
import { Prisma, type MeasurementType } from "@/generated/prisma/client";
import { utcBucketEnd } from "@/lib/rollups/measurement-read";
import { ROLLUP_FOLD_WINDOW_MS } from "@/lib/rollups/measurement-rollups";
import { readTierCoveredTypes } from "@/lib/rollups/tier-coverage";
import { liveTypeDescent } from "@/lib/measurements/live-type-descent";
import { closedBlockKeyPart } from "@/lib/cache/closed-block";
import { caches, type ServerCache } from "@/lib/cache/server-cache";

/**
 * The live readings of the type `mt."type"` in `[since, until]`, counted
 * through `liveTypeDescent`. The descent's ORDER BY is what only the live
 * `(user_id, type, measured_at)` index returns, and the LIMIT the planner
 * cannot see costs it as stopping early, so a count over an account the
 * statistics do not know is not read through the type-less
 * `(user_id, measured_at)` index once per type. The limit itself never
 * binds.
 */
function countOf(
  userId: string,
  since: Date | null,
  until: Date | null,
): Prisma.Sql {
  return Prisma.sql`(SELECT COUNT(*) FROM (
      SELECT 1 FROM measurements m
      ${liveTypeDescent(userId, Prisma.sql`mt."type"::measurement_type`, "newest", since, until)}
      LIMIT (SELECT 2147483647::int)
    ) x)`;
}

/** A closed block's lifetime when no write reaches it. */
const PRE_TIER_COUNT_TTL_MS = 15 * 60_000;

/**
 * Live readings per type older than `tierFrom`, the readings the tier never
 * holds. A closed block (`closedBlockKeyPart`): no write after the fold
 * window changes it, so it is folded once and kept until a write reaches
 * back before `tierFrom` or the split moves to the next day.
 */
async function readPreTierCounts(
  userId: string,
  types: readonly MeasurementType[],
  tierFrom: Date,
): Promise<Map<string, number>> {
  const sorted = [...types].sort();
  const cache = caches.analytics as ServerCache<Array<[string, number]>>;
  const { value } = await cache.wrap(
    `${userId}|pre-tier-counts|${closedBlockKeyPart(tierFrom)}|${sorted.join(",")}`,
    async () =>
      (
        await prisma.$queryRaw<Array<{ type: string; n: bigint | number }>>`
          SELECT mt."type" AS type,
                 ${countOf(userId, null, new Date(tierFrom.getTime() - 1))} AS n
          FROM unnest(${sorted}::text[]) AS mt("type")`
      ).map((r): [string, number] => [r.type, Number(r.n)]),
    PRE_TIER_COUNT_TTL_MS,
  );
  return new Map(value);
}

export async function countLiveReadings(
  userId: string,
  types: readonly MeasurementType[],
  since: Date | null,
  now: Date = new Date(),
): Promise<Map<MeasurementType, number>> {
  const out = new Map<MeasurementType, number>();
  const list = [...new Set(types)];
  if (list.length === 0) return out;
  const edge = new Date(now.getTime() - ROLLUP_FOLD_WINDOW_MS);
  const tierFrom = utcBucketEnd(
    since !== null && since > edge ? since : edge,
    "DAY",
  );
  const covered = (await readTierCoveredTypes(userId, list, tierFrom)).map(
    (r) => r.type,
  );
  const type = Prisma.sql`mt."type"::measurement_type`;
  // `measured_at` is stored to the millisecond, so this is `< tierFrom`.
  const beforeTier = new Date(tierFrom.getTime() - 1);
  const [preTier, rows] = await Promise.all([
    since === null
      ? readPreTierCounts(userId, list, tierFrom)
      : Promise.resolve(null),
    prisma.$queryRaw<
      Array<{ type: string; head: bigint | number; rest: bigint | number }>
    >`
      SELECT
        mt."type" AS type,
        ${since === null ? Prisma.sql`0` : countOf(userId, since, beforeTier)} AS head,
        CASE WHEN mt."type" = ANY(${covered}::text[])
          THEN (SELECT COALESCE(SUM(r."count"), 0) FROM measurement_rollups r
                 WHERE r."user_id" = ${userId}
                   AND r."type" = ${type}
                   AND r."granularity" = 'DAY'
                   AND r."bucket_start" >= ${tierFrom})
          ELSE ${countOf(userId, tierFrom, null)}
        END AS rest
      FROM unnest(${list}::text[]) AS mt("type")
    `,
  ]);
  for (const r of rows) {
    const n = Number(r.head) + Number(r.rest) + (preTier?.get(r.type) ?? 0);
    if (n > 0) out.set(r.type as MeasurementType, n);
  }
  return out;
}
