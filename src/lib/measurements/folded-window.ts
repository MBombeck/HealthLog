/**
 * The `folded_window` ingest guard (v1.42).
 *
 * The dense-intraday consolidation folds the raw Apple Health samples of a
 * DENSE type into one `stats:` row per local hour once they are older than
 * the retention window, and a MEAN type into one `stats:` row per local day
 * once the consolidation grace has passed. Since v1.42 the folded raw rows are
 * deleted outright rather than left as tombstones, so a client that re-uploads
 * an old sample after losing its anchor would put it back beside the hour or
 * day that already accounts for it. A raw (non-`stats:`) Apple Health value of
 * such a type, old enough to have been folded, is therefore a duplicate when a
 * live `stats:` row covers its hour or day. The batch route and the ZIP import
 * apply the same rule.
 *
 * Health Connect does not use this: its importer writes the folded shape
 * itself.
 *
 * Contract stub: the rules and the pure candidate check are final; the lookup
 * that finds the covering `stats:` rows returns nothing until it is built, so
 * nothing is refused yet.
 */
import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";
import { HIGH_FREQUENCY_MEAN_TYPES } from "@/lib/measurements/apple-health-mapping";
import { CONSOLIDATION_GRACE_CUTOFF_HOURS } from "@/lib/measurements/consolidation-tz";
import {
  DENSE_INTRADAY_RETENTION_DAYS,
  DENSE_INTRADAY_RETENTION_TYPES,
} from "@/lib/measurements/dense-intraday-retention";

/** The per-entry status reason the batch result carries for such a row. */
export type FoldedWindowReason = "folded_window";

const HOUR_MS = 3_600_000;

/** Which types fold into which window, and from what age. */
export const FOLDED_WINDOW_RULES = [
  {
    window: "hour",
    types: DENSE_INTRADAY_RETENTION_TYPES,
    foldedAfterMs: DENSE_INTRADAY_RETENTION_DAYS * 24 * HOUR_MS,
  },
  {
    window: "day",
    types: HIGH_FREQUENCY_MEAN_TYPES,
    foldedAfterMs: CONSOLIDATION_GRACE_CUTOFF_HOURS * HOUR_MS,
  },
] as const;

/** The fields of an incoming row the guard reads. */
export interface FoldedWindowCandidateRow {
  type: MeasurementType;
  source: MeasurementSource;
  externalId: string | null;
  measuredAt: Date;
}

/**
 * Whether a row is old enough, and of the right kind, for its hour or day to
 * have been folded already. Pure: whether a live `stats:` row actually covers
 * it is the lookup's question.
 */
export function isFoldedWindowCandidate(
  row: FoldedWindowCandidateRow,
  now: Date = new Date(),
): boolean {
  if (row.source !== "APPLE_HEALTH") return false;
  if (row.externalId?.startsWith("stats:")) return false;
  const age = now.getTime() - row.measuredAt.getTime();
  return FOLDED_WINDOW_RULES.some(
    (rule) => rule.types.has(row.type) && age > rule.foldedAfterMs,
  );
}

/**
 * Indexes (into `rows`) of the candidates whose hour or day a live `stats:`
 * row already covers. Stub: returns none.
 */
export async function findFoldedWindowDuplicates(
  tx: Prisma.TransactionClient,
  userId: string,
  rows: readonly FoldedWindowCandidateRow[],
): Promise<Set<number>> {
  void tx;
  void userId;
  void rows;
  return new Set();
}
