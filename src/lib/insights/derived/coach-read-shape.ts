/**
 * v1.21.2 (A1) — "Coach read" strip: shared shapes + pure selection logic.
 *
 * Client-safe (no `server-only`, no Prisma): the DTO shapes the route returns
 * and the strip renders, plus the two pure decisions the strip turns on —
 * band placement (within / above / below) and the on-metric driver pick. The
 * server builder (`coach-read.ts`) composes these over the baseline +
 * correlation engines; the unit test pins them directly.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { CoachCorrelationDriver } from "@/lib/ai/coach/tools/correlations-read";

/** Where today's latest reading sits relative to the personal band. */
export type CoachReadBaselinePlacement = "within" | "above" | "below";

/** The resolved own-baseline line (line 1). */
export interface CoachReadBaseline {
  /** Robust lower edge of the personal typical range. */
  low: number;
  /** Robust upper edge of the personal typical range. */
  high: number;
  /** Today's latest reading (display value, same units as the band). */
  latest: number;
  /** Where the latest reading sits relative to the band. */
  placement: CoachReadBaselinePlacement;
  /** Distinct days that fed the band (transparency). */
  sampleDays: number;
  /**
   * `"sameHours"` when today is still in progress for a type whose day mean
   * moves with the hour (glucose): `latest` is today's mean so far and
   * `low` / `high` are the usual range for the same hours of the earlier
   * days, not the whole-day band. A surface naming the range says so.
   * Absent for the whole-day comparison.
   */
  basis?: "sameHours";
}

/** The resolved lagged-association line (line 2). */
export interface CoachReadDriver {
  /** The engine's conservative, descriptive, never-causal interpretation. */
  note: string;
  /** Lower-cased behaviour label (e.g. "sleep duration"). */
  behaviour: string;
  /** Lower-cased outcome label (this metric). */
  outcome: string;
}

export interface CoachReadStripData {
  /**
   * The own-baseline line. `null` when the band has < 7 days of history
   * (`learning: true`) or when there is no latest reading to place.
   */
  baseline: CoachReadBaseline | null;
  /**
   * True when a band could not be established yet (history below the
   * engine's 7-day floor, or no readings). Drives the "still learning your
   * range" copy. Mutually exclusive with a non-null `baseline`.
   */
  learning: boolean;
  /**
   * The single strongest lagged driver whose outcome is this metric, or
   * `null` when none clears the existing effect-size floor (line 2 omitted).
   */
  driver: CoachReadDriver | null;
}

/**
 * `humanise()` in the correlations reader maps a discovery channel key to a
 * lower-cased label. We need the SAME mapping to recognise which discovered
 * drivers land on this page's metric. Kept byte-identical to the reader's
 * private helper for MeasurementType keys.
 */
export function humaniseType(type: MeasurementType): string {
  return String(type).replace(/_/g, " ").toLowerCase();
}

/**
 * Where today's reading sits relative to the personal band. Pure. The band
 * edges are inclusive — a reading exactly on an edge reads "within".
 */
export function placeAgainstBand(
  latest: number,
  low: number,
  high: number,
): CoachReadBaselinePlacement {
  if (latest > high) return "above";
  if (latest < low) return "below";
  return "within";
}

/**
 * Pick the strongest driver whose OUTCOME is this metric. The reader already
 * floors + tiers + FDR-controls the list; we only choose the page-relevant
 * row with the largest |r| so the strip surfaces the single most informative
 * link. Returns `null` when no driver lands on the metric.
 */
export function pickDriverForMetric(
  drivers: CoachCorrelationDriver[],
  outcomeLabel: string,
): CoachCorrelationDriver | null {
  const onMetric = drivers.filter((d) => d.outcome === outcomeLabel);
  if (onMetric.length === 0) return null;
  return onMetric.reduce((best, cur) =>
    Math.abs(cur.r) > Math.abs(best.r) ? cur : best,
  );
}
