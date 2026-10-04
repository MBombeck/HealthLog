/**
 * v1.4.36 — per-type rollup coverage probe.
 *
 * The v1.4.35/v1.4.36 read-swap gates on whether the DAY rollup table
 * carries buckets for a user. The first iteration checked a single
 * `COUNT(*) > 0` against `measurement_rollups`. That returns `true` as
 * soon as *any* type has buckets, which breaks the "first measurement
 * for a brand-new type" case: the per-write hook upserts one DAY bucket
 * for the new type → the global probe stays >0 → the read path picks
 * the bucket-derived branch for *every* type → the brand-new type's
 * narrow-aggregate windowed columns come back fine but the seed loop
 * only iterates bucket-bearing types, so a type that has live
 * measurements but no buckets falls out of the response entirely.
 *
 * The probe below joins `measurements`-distinct-types against
 * `measurement_rollups` so the caller learns, per type, whether the
 * bucket table covers it. Types with `hasBuckets=false` fall back to
 * the live aggregator branch; types with `hasBuckets=true` ride the
 * cheap composed branch. The result is a single round-trip indexed
 * read regardless of how many types the user has logged.
 */
import { prisma } from "@/lib/db";
import { joinCoverageProbe } from "@/lib/rollups/coverage-inflight";
import { ROLLUP_FOLD_WINDOW_MS } from "@/lib/rollups/measurement-rollups";

/**
 * Per-type coverage map. `true` means at least one DAY rollup row
 * exists for this `(user, type)` pair; the caller can safely compose
 * `count / min / max / mean` from the bucket table for this type.
 * `false` means the bucket table is empty for this type and the caller
 * must fall back to the live aggregate.
 *
 * Types the user has never logged are absent from the map — callers
 * never need to ask about a type with zero measurements.
 */
export type RollupCoverageMap = Map<string, boolean>;

/**
 * Probe DAY-bucket coverage for every type the user has measurements
 * for, in one round-trip.
 *
 * The distinct-type set is read as a loose index scan: a recursive CTE
 * that hops from one type to the next along the partial
 * `(user_id, type, measured_at)` live index, one index descent per type
 * instead of a walk over every live row the user has. Coverage is an
 * `EXISTS` per type on the rollup index, which stops at the first DAY
 * bucket rather than counting them all.
 *
 * The earlier shape, `SELECT DISTINCT type` joined to a `COUNT(r.*)`
 * over every DAY bucket, read all of a user's live rows and all of their
 * DAY buckets on each call; on a tenant with years of Apple Health data
 * the planner chose a sequential scan of `measurement_rollups` for the
 * join. It returns the same map; only the reads changed.
 *
 * Concurrent probes for one account share the query already in flight (see
 * `coverage-inflight.ts`); each caller still receives its own map.
 */
export function probeRollupCoverage(
  userId: string,
): Promise<RollupCoverageMap> {
  return joinCoverageProbe(userId, () => readRollupCoverage(userId));
}

async function readRollupCoverage(userId: string): Promise<RollupCoverageMap> {
  const rows = await prisma.$queryRaw<
    Array<{ type: string; has_buckets: boolean }>
  >`
    WITH RECURSIVE live_types AS (
      (
        SELECT "type"
        FROM measurements
        WHERE user_id = ${userId}
          AND "deleted_at" IS NULL
        ORDER BY "type"
        LIMIT 1
      )
      UNION ALL
      SELECT (
        SELECT m."type"
        FROM measurements m
        WHERE m.user_id = ${userId}
          AND m."deleted_at" IS NULL
          AND m."type" > live_types."type"
        ORDER BY m."type"
        LIMIT 1
      )
      FROM live_types
      WHERE live_types."type" IS NOT NULL
    )
    SELECT
      t."type"::text AS type,
      EXISTS (
        SELECT 1
        FROM measurement_rollups r
        WHERE r.user_id     = ${userId}
          AND r."type"      = t."type"
          AND r.granularity = 'DAY'
      ) AS has_buckets
    FROM live_types t
    WHERE t."type" IS NOT NULL
  `;
  const coverage: RollupCoverageMap = new Map();
  for (const row of rows) {
    coverage.set(row.type, Boolean(row.has_buckets));
  }
  return coverage;
}

/**
 * Convenience — `true` when the user has at least one measurement and
 * every type with measurements also has DAY-bucket coverage. The read
 * path can skip the live aggregate entirely.
 */
export function isFullyCovered(coverage: RollupCoverageMap): boolean {
  if (coverage.size === 0) return false;
  for (const hasBuckets of coverage.values()) {
    if (!hasBuckets) return false;
  }
  return true;
}

/**
 * Of `types`, the ones this user has a live reading of inside the fold
 * window — the only ones the fold can ever give a bucket.
 *
 * The fold writes buckets inside `ROLLUP_FOLD_WINDOW_MS` and nowhere else, so
 * a type whose every reading is older than that reports `false` in
 * `probeRollupCoverage` for good. A caller that waits for coverage before
 * taking a path has to tell that apart from a type the backfill simply has
 * not reached yet, or it waits forever. One indexed `EXISTS` per type on
 * `(user_id, type, measured_at)`; callers ask only about the types their
 * probe found uncovered.
 */
export async function typesWithReadingsInFoldWindow(
  userId: string,
  types: readonly string[],
): Promise<Set<string>> {
  if (types.length === 0) return new Set();
  const windowStart = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
  const rows = await prisma.$queryRaw<Array<{ type: string }>>`
    SELECT candidate."type"
    FROM unnest(${[...types]}::text[]) AS candidate("type")
    WHERE EXISTS (
      SELECT 1
      FROM measurements m
      WHERE m.user_id       = ${userId}
        AND m."type"        = candidate."type"::measurement_type
        AND m."deleted_at"  IS NULL
        AND m."measured_at" >= ${windowStart}
    )
  `;
  return new Set(rows.map((row) => row.type));
}
