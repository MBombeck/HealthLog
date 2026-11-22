/**
 * The comparisons the measurement reconciler decides by, beside it so it
 * stays readable: which of two `stats:` aggregates is the authority, whether
 * a row already holds an entry's natural identity, and whether an incoming
 * `stats:` total was computed before the stored one.
 */
import type {
  Measurement,
  MeasurementAggregationProvenance,
} from "@/generated/prisma/client";
import type { ExternalMeasurementWrite } from "@/lib/measurements/reconcile-external-measurement";

const AGGREGATION_AUTHORITY: Readonly<
  Record<MeasurementAggregationProvenance, number>
> = {
  LEGACY_UNKNOWN: 1,
  EXPORT_XML_SOURCE_MAX: 2,
  HEALTHKIT_STATISTICS: 3,
};

export function aggregationAuthority(
  value: MeasurementAggregationProvenance | null | undefined,
): number {
  return value === null || value === undefined
    ? 0
    : AGGREGATION_AUTHORITY[value];
}

export function sameNaturalIdentity(
  row: Pick<Measurement, "measuredAt" | "sleepStage">,
  desired: ExternalMeasurementWrite,
): boolean {
  return (
    row.measuredAt.getTime() === desired.measuredAt.getTime() &&
    row.sleepStage === (desired.sleepStage ?? null)
  );
}

/**
 * The stored `stats:` total was computed after the incoming one, so the
 * incoming write is an out-of-order replay. Only a live row and an entry that
 * both carry `statsComputedAt` are compared.
 */
export function isStaleStatsWrite(
  stored: Pick<Measurement, "deletedAt" | "statsComputedAt">,
  desired: ExternalMeasurementWrite,
): boolean {
  const incoming = desired.statsComputedAt;
  return (
    stored.deletedAt == null &&
    stored.statsComputedAt != null &&
    incoming instanceof Date &&
    stored.statsComputedAt.getTime() > incoming.getTime()
  );
}
