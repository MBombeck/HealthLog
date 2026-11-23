/**
 * Illness retrospective summary (v1.18.1, Workstream B / P3).
 *
 * The look-back surface: "sick N times this year · typical recovery gap X
 * days". RETROSPECTIVE ONLY — it summarises what already happened. It is
 * NEVER a predictor or diagnoser; the recurrence figure is a count of past
 * episodes, not a forecast, and the copy layer must frame it as such.
 *
 * Pure given a list of resolved episode summaries + their computed gaps. The
 * caller resolves the per-episode recovery-gap (via the correlation engine,
 * which is itself coverage-gated) and passes the numbers in; this layer only
 * aggregates. The aggregate is itself gated — with too few resolved episodes
 * to say anything honest, it reports the count but withholds the "typical
 * gap" (asserts nothing thin).
 */

import { median } from "@/lib/stats/central";

/**
 * Minimum episodes that each clear the per-episode signal floor before a
 * "typical recovery gap" is asserted. A gap is only honest once several
 * episodes independently back it, so one or two coincidental gaps never
 * become a "typical" claim.
 */
export const MIN_EPISODES_FOR_TYPICAL_GAP = 3;

/**
 * Minimum distinct episode days carrying a real measurement before an
 * episode's recovery-gap may feed the typical-gap median. Below this an
 * episode's window holds too few genuine vitals for its computed gap to mean
 * anything — a couple of readings happening to surround the onset/recovery
 * markers produce a spurious gap. The correlation engine's own
 * `MIN_EPISODE_COVERAGE_DAYS` floor (4) is the engine-side gate; this is the
 * aggregate-side reinforcement so a barely-covered episode does not tip the
 * median. Sourced from `Derived.coverage.historyDays`.
 */
export const MIN_GAP_MEASUREMENT_DAYS = 4;

/**
 * Minimum absolute magnitude (days) the typical gap must reach before it is
 * surfaced. A median gap of 0 — and the ±1-day jitter around it — is the
 * dominant outcome of coincidental data (numbers and feeling settle on the
 * same day), so it carries no signal worth a headline. Only a gap that
 * genuinely separates the felt-better marker from the physiological return
 * is shown.
 */
export const MIN_TYPICAL_GAP_MAGNITUDE_DAYS = 2;

/** One episode's contribution to the summary. */
export interface RetrospectiveEpisode {
  id: string;
  type: string;
  /** Onset local day `YYYY-MM-DD` (for the recurrence-month tally). */
  onsetDay: string;
  /** Whether the episode is resolved (has a felt-better marker). */
  resolved: boolean;
  /** The computed recovery-gap in days, or null when ungated/unavailable. */
  recoveryGapDays: number | null;
  /**
   * Distinct episode days that carried a real measurement (the correlation
   * engine's coverage `historyDays`). Drives the per-episode signal floor:
   * an episode below `MIN_GAP_MEASUREMENT_DAYS` contributes no gap even if
   * the engine computed one. Absent/0 → does not qualify.
   */
  gapMeasurementDays?: number;
  /**
   * The vital metric types that produced a non-null physiological-return gap
   * for this episode (the engine's `returns[]` filtered to a real return).
   * Tallied across the qualifying episodes to name the dominant driving vital
   * in the cross-episode summary ("felt better ~X days before resting heart
   * rate settled"). Absent/empty → contributes no driver.
   */
  gapReturnTypes?: string[];
  /** Lifecycle — CHRONIC_ONGOING never contributes a gap. */
  lifecycle: string;
}

export interface IllnessRetrospectiveSummary {
  /** Episodes whose onset falls in the requested window (e.g. trailing year). */
  episodeCount: number;
  /** Of those, how many are resolved. */
  resolvedCount: number;
  /**
   * Typical (median) recovery-gap in days across episodes with a computed
   * gap — null when fewer than `MIN_EPISODES_FOR_TYPICAL_GAP` qualify. A
   * positive gap means the body typically lagged the felt-better marker.
   */
  typicalRecoveryGapDays: number | null;
  /** How many episodes backed the typical-gap figure (transparency). */
  gapSampleSize: number;
  /**
   * Recurrence tally by calendar month (1–12) → count, retrospective only.
   * Drives "you tend to log illnesses in November" as an OBSERVATION, never
   * a prediction. Empty when nothing falls in the window.
   */
  byMonth: Record<number, number>;
  /** Per-type episode counts in the window (retrospective breakdown). */
  byType: Record<string, number>;
  /**
   * The dominant vital that drove the typical recovery gap — the metric type
   * that most often produced a physiological return across the qualifying
   * episodes — or null when no gap is surfaced or no vital clearly leads. The
   * card names it ("…before resting heart rate settled"). Retrospective only.
   */
  gapDriverType: string | null;
}

/**
 * Aggregate the per-episode figures into the retrospective summary. Pure.
 *
 * The typical-gap is withheld (null) unless ALL THREE signal-density gates
 * hold, so coincidental data never surfaces a speculative "Erholungslücke":
 *   1. each contributing episode cleared the per-episode measurement floor
 *      (`gapMeasurementDays >= MIN_GAP_MEASUREMENT_DAYS`),
 *   2. at least `MIN_EPISODES_FOR_TYPICAL_GAP` such episodes qualify, and
 *   3. the resulting median magnitude reaches
 *      `MIN_TYPICAL_GAP_MAGNITUDE_DAYS` (a 0/±1-day gap is noise).
 * `gapSampleSize` reports the count of episodes that cleared gates 1–2 (the
 * transparency figure), independent of the magnitude gate.
 */
export function summarizeIllnessRetrospective(
  episodes: RetrospectiveEpisode[],
): IllnessRetrospectiveSummary {
  const byMonth: Record<number, number> = {};
  const byType: Record<string, number> = {};
  let resolvedCount = 0;
  const gaps: number[] = [];
  // Tally of which vital produced a physiological return, across only the
  // episodes that qualified for the typical-gap median — the dominant one
  // names the driving vital in the card.
  const driverTally: Record<string, number> = {};

  for (const e of episodes) {
    const month = Number(e.onsetDay.slice(5, 7));
    if (month >= 1 && month <= 12) byMonth[month] = (byMonth[month] ?? 0) + 1;
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.resolved) resolvedCount++;
    if (
      e.lifecycle !== "CHRONIC_ONGOING" &&
      e.recoveryGapDays !== null &&
      Number.isFinite(e.recoveryGapDays) &&
      // Per-episode signal floor: a barely-covered episode contributes no
      // gap even if the engine computed one.
      (e.gapMeasurementDays ?? 0) >= MIN_GAP_MEASUREMENT_DAYS
    ) {
      gaps.push(e.recoveryGapDays);
      for (const type of e.gapReturnTypes ?? [])
        driverTally[type] = (driverTally[type] ?? 0) + 1;
    }
  }

  const medianGap =
    gaps.length >= MIN_EPISODES_FOR_TYPICAL_GAP
      ? Math.round(median(gaps)!)
      : null;

  // Magnitude gate: a 0/±1-day gap is the coincidental-data baseline and
  // carries no signal worth a headline.
  const typicalRecoveryGapDays =
    medianGap !== null && Math.abs(medianGap) >= MIN_TYPICAL_GAP_MAGNITUDE_DAYS
      ? medianGap
      : null;

  // Name the driving vital only when a gap is actually surfaced — the most
  // frequently-returning vital across the qualifying episodes. Ties resolve
  // deterministically by metric name so the copy is stable across reads.
  const gapDriverType =
    typicalRecoveryGapDays !== null
      ? (Object.entries(driverTally).sort((a, b) =>
          b[1] !== a[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : 1,
        )[0]?.[0] ?? null)
      : null;

  return {
    episodeCount: episodes.length,
    resolvedCount,
    typicalRecoveryGapDays,
    gapSampleSize: gaps.length,
    byMonth,
    byType,
    gapDriverType,
  };
}
