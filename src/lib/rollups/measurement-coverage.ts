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
 * for. The join is anchored on the smaller `DISTINCT type FROM
 * measurements` set so the planner picks the per-type
 * `(user_id, type, measured_at)` index path; the LEFT JOIN onto the
 * rollup table uses the `(user_id, type, granularity, bucket_start)`
 * composite primary key. A `COUNT > 0` per partition keeps the result
 * shape stable even when a type has zero buckets.
 */
export async function probeRollupCoverage(
  userId: string,
): Promise<RollupCoverageMap> {
  const rows = await prisma.$queryRaw<
    Array<{ type: string; has_buckets: boolean }>
  >`
    SELECT
      m."type"::text                 AS type,
      COUNT(r.*) > 0                 AS has_buckets
    FROM (
      SELECT DISTINCT "type"
      FROM measurements
      WHERE user_id = ${userId}
        AND "deleted_at" IS NULL
    ) m
    LEFT JOIN measurement_rollups r
      ON  r.user_id     = ${userId}
      AND r."type"      = m."type"
      AND r.granularity = 'DAY'
    GROUP BY m."type"
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
