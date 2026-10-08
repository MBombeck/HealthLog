/**
 * Which measurement types an account has live rows of (v1.42).
 *
 * Several readers ask this ("which types exist?") on the request path and in
 * nightly passes. A `groupBy` answers it by reading every live row of the
 * account, which on a dense multi-year Apple Health history is a six-figure
 * row set for a two-digit answer. This helper walks the partial
 * `measurements_live_covering_idx (user_id, type, measured_at DESC) WHERE
 * deleted_at IS NULL` (migration 0183) as a loose index scan instead: a
 * recursive CTE that asks for the first type, then the first type greater
 * than it, once per distinct type, each an index probe.
 *
 * `MeasurementType` is a Postgres enum, so both `ORDER BY type` and
 * `type > …` follow the enum's declaration order, which is the order the
 * `groupBy … orderBy: { type: "asc" }` it replaces returned.
 *
 * A `source` filter is not in the index and is checked against the heap for
 * the rows each probe visits; it stays correct, and is cheap for the sources
 * that make up most of a type's rows.
 */
import {
  Prisma,
  type MeasurementSource,
  type MeasurementType,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export async function listLiveMeasurementTypes(
  userId: string,
  options: {
    source?: MeasurementSource;
    types?: readonly MeasurementType[];
  } = {},
): Promise<MeasurementType[]> {
  if (options.types && options.types.length === 0) return [];
  // Both fragments are parameter-bound; the enum casts are literal SQL.
  const sourceFilter = options.source
    ? Prisma.sql`AND "source" = ${options.source}::"measurement_source"`
    : Prisma.empty;
  const typeFilter = options.types
    ? Prisma.sql`AND "type" = ANY(${[...options.types]}::"measurement_type"[])`
    : Prisma.empty;
  const rows = await prisma.$queryRaw<Array<{ type: MeasurementType }>>`
    WITH RECURSIVE live_types AS (
      (
        SELECT "type"
        FROM "measurements"
        WHERE "user_id" = ${userId} AND "deleted_at" IS NULL
          ${sourceFilter} ${typeFilter}
        ORDER BY "type"
        LIMIT 1
      )
      UNION ALL
      SELECT (
        SELECT m."type"
        FROM "measurements" m
        WHERE m."user_id" = ${userId} AND m."deleted_at" IS NULL
          AND m."type" > live_types."type"
          ${sourceFilter} ${typeFilter}
        ORDER BY m."type"
        LIMIT 1
      )
      FROM live_types
      WHERE live_types."type" IS NOT NULL
    )
    SELECT "type"::text AS "type" FROM live_types WHERE "type" IS NOT NULL
  `;
  return rows.map((row) => row.type);
}
