/**
 * v1.25 — breathing-disturbance screening shaping.
 *
 * Reads the per-night sleep-breathing-disturbance index
 * (`BREATHING_DISTURBANCES`, lower-better) and the device-flagged
 * breathing-disturbance / possible-apnea events (`BREATHING_DISTURBANCE_EVENT`)
 * a sync writes, and folds them into a calm awareness summary: how many nights
 * are covered, the recent mean index, the short-window trend, and the device's
 * own classification.
 *
 * This is a SCREENING SIGNAL ONLY — never a HealthLog diagnosis. The card built
 * on top of this states that explicitly. The classification mirrors the device:
 * a night the device flagged with one or more elevated-breathing events reads
 * as "elevated"; with index nights and no flagged event it reads as
 * "not-elevated". HealthLog invents no numeric threshold of its own.
 *
 * The math lives here, free of Prisma, so the present / absent / trend states
 * are unit-testable in isolation.
 */

import { mean } from "@/lib/stats/central";

/** A single per-night reading (index) or a device-flagged event row. */
export interface BreathingRow {
  value: number;
  measuredAt: Date;
}

export type BreathingTrend = "up" | "down" | "stable" | null;
export type BreathingClassification = "not-elevated" | "elevated" | null;

export interface BreathingScreeningSummary {
  /** True when there is any index night or any flagged event to surface. */
  present: boolean;
  /** Number of nights with a per-night index reading. */
  nights: number;
  /** Mean of the index readings (lower-better), rounded to 1dp; null when none. */
  recentMeanIndex: number | null;
  /**
   * Direction of the recent index vs the prior window. "up" is worse (more
   * disturbance). Null when there are too few nights to compare.
   */
  trend: BreathingTrend;
  /** Count of device-flagged breathing-disturbance / apnea events. */
  eventCount: number;
  /**
   * The device's own classification: "elevated" when it flagged events,
   * "not-elevated" when there are index nights and no flagged event, null when
   * there is no data at all.
   */
  classification: BreathingClassification;
}

/** Window (most-recent nights) the trend compares against the prior block. */
const TREND_WINDOW_NIGHTS = 7;
/** Need at least this many nights total before a trend is meaningful. */
const MIN_TREND_NIGHTS = 6;
/** Relative band within which the recent mean reads as "stable". */
const STABLE_BAND = 0.1;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Summarise the breathing-screening signal. `indexRows` are the per-night
 * index readings; `eventRows` are the device-flagged events. Order-independent
 * — the helper sorts by `measuredAt` for the trend.
 */
export function summariseBreathing(
  indexRows: readonly BreathingRow[],
  eventRows: readonly BreathingRow[],
): BreathingScreeningSummary {
  const sorted = [...indexRows]
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());

  const nights = sorted.length;
  const eventCount = eventRows.length;

  if (nights === 0 && eventCount === 0) {
    return {
      present: false,
      nights: 0,
      recentMeanIndex: null,
      trend: null,
      eventCount: 0,
      classification: null,
    };
  }

  const values = sorted.map((r) => r.value);
  const valuesMean = mean(values);
  const recentMeanIndex = valuesMean === null ? null : round1(valuesMean);

  let trend: BreathingTrend = null;
  if (nights >= MIN_TREND_NIGHTS) {
    const recent = values.slice(-TREND_WINDOW_NIGHTS);
    const prior = values.slice(0, -TREND_WINDOW_NIGHTS);
    const recentMean = mean(recent);
    const priorMean = mean(prior);
    if (recentMean !== null && priorMean !== null) {
      const band = Math.abs(priorMean) * STABLE_BAND;
      const delta = recentMean - priorMean;
      trend = Math.abs(delta) <= band ? "stable" : delta > 0 ? "up" : "down";
    }
  }

  const classification: BreathingClassification =
    eventCount > 0 ? "elevated" : nights > 0 ? "not-elevated" : null;

  return {
    present: true,
    nights,
    recentMeanIndex,
    trend,
    eventCount,
    classification,
  };
}
