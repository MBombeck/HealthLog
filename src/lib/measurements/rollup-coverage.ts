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
 * Returns the set of types the user has logged that do NOT yet have
 * DAY-rollup coverage. The bucket-fresh read paths use this to decide
 * which types still need the live aggregator branch.
 */
export function typesMissingCoverage(coverage: RollupCoverageMap): string[] {
  const missing: string[] = [];
  for (const [type, hasBuckets] of coverage.entries()) {
    if (!hasBuckets) missing.push(type);
  }
  return missing;
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
