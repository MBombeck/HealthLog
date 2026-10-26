/**
 * The rows a metric series reads, restricted to the source the user's priority
 * ladder picks for each day.
 *
 * The rollup tier and sleep already resolve every (type, day) to the
 * ladder-winning source before they aggregate. The dense and raw reads of
 * `/api/measurements/series` filtered on user and type only, so with a second
 * provider a day's value blended the two and the configured ladder had no
 * effect on those charts. This is the one place that applies the same rule to
 * them, through the same SQL helper the other live readers use.
 *
 * Only a type that HAS a ladder is collapsed (`RANKED_TYPES`). For a type
 * without one (glucose, body water, bone mass) the helper would break the tie
 * by source name, which silently hides one of two real sources, so those keep
 * every source exactly as before.
 *
 * Returns a FROM-clause subquery aliased `m`; the user id is bound as `$1`.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import {
  RANKED_TYPES,
  buildSourceRankCase,
  canonicalMeasurementsFrom,
} from "@/lib/analytics/source-rank-sql";
import { instantLiteralSql } from "@/lib/analytics/request-clock-sql";

const ENUM_RE = /^[A-Z0-9_]+$/;

export function seriesRowsFrom(
  priorityJson: unknown,
  type: MeasurementType,
  since: Date,
): string {
  if (!ENUM_RE.test(type)) {
    throw new Error(`unsafe enum literal for SQL splice: ${type}`);
  }
  if (!RANKED_TYPES.includes(type)) {
    return `(
        SELECT mm.*
        FROM measurements mm
        WHERE mm."user_id" = $1
          AND mm."type" = '${type}'::"measurement_type"
          AND mm."deleted_at" IS NULL
      ) m`;
  }
  // One day wider than the request: the caller trims to its exact `since`, so
  // the edge day's source is picked from all of its readings, not from the
  // slice the window happens to include. The window counts from the caller's
  // `since`, its own clock, never from the database's.
  return canonicalMeasurementsFrom(
    buildSourceRankCase(priorityJson, '"type"', '"source"'),
    { from: instantLiteralSql(since), interval: "1 day" },
    type,
  );
}
