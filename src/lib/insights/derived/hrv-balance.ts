/**
 * v1.10.0 — catalogue metric #8: HRV (SDNN) trend / balance.
 *
 * `computeHrvBalance(userId, profile, opts)` builds the personal-baseline
 * band for `HEART_RATE_VARIABILITY` (the same median ± k·MAD engine the
 * flagship vitals baseline uses) and places the recent 7-day SDNN average
 * against it as a Balanced / Unbalanced / Low band — the honest day-scale
 * analogue of Garmin "HRV Status" / WHOOP "HRV Trend".
 *
 *   - **baseline** = the `computeVitalsBaseline` band for
 *     `HEART_RATE_VARIABILITY` (median ± k·MAD over the window, DAY-native).
 *   - **recentAvg** = mean of the DAY means of the trailing 7 days before
 *     `now` (the window the dashboard's 7-day mean covers).
 *   - **band** — recentAvg inside the baseline band → Balanced (green);
 *     above the band → Unbalanced-high (yellow); below the band's low edge →
 *     Low (red). The Low edge is the one that matters clinically (suppressed
 *     HRV); a high excursion is flagged but not alarmed.
 *
 * SDNN ≠ RMSSD. This is surfaced strictly as "HRV (SDNN) trend", never
 * relabelled RMSSD and never presented as a population-normed HRV grade — it
 * is a personal trend band. Cadence-gated: SDNN is not guaranteed nightly,
 * so the ≥ 7-distinct-day floor of the baseline engine gates the band.
 *
 * Standard: Task Force of the European Society of Cardiology and the North
 * American Society of Pacing and Electrophysiology 1996, "Heart rate
 * variability: standards of measurement, physiological interpretation, and
 * clinical use", Circulation 93(5):1043–1065 (the SDNN reference).
 *
 * Server-only — delegates the DB read to the baseline engine. The band
 * placement helper is exported pure for the unit tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import {
  computeVitalsBaseline,
  readDayMeanSeries,
  type BaselineProfile,
  type DayMeanPoint,
} from "./baseline";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { isDerivedOk, SPARKLINE_MAX_POINTS } from "./types";
import type { Derived } from "./types";

const HRV_TYPE: MeasurementType = "HEART_RATE_VARIABILITY";

/** The recent trend rides the DAY means of this many trailing days. */
const RECENT_TREND_DAYS = 7;

/** Personal-trend balance placement. */
export type HrvBalanceBand = "balanced" | "unbalanced" | "low";

/** The successful `value` payload for the HRV (SDNN) balance card. */
export interface HrvBalanceValue {
  /** The SDNN average over the trailing 7 days (ms). */
  recentAvg: number;
  /** Personal-baseline center (median of DAY means, ms). */
  baselineCenter: number;
  /** Personal-baseline band low edge (ms). */
  baselineLow: number;
  /** Personal-baseline band high edge (ms). */
  baselineHigh: number;
  /** Balanced / unbalanced (high) / low placement of recentAvg vs the band. */
  band: HrvBalanceBand;
  /** Distinct days that backed the baseline. */
  sampleDays: number;
  /**
   * Trailing per-day SDNN mean series (oldest → newest), capped to the last
   * `SPARKLINE_MAX_POINTS`. Reuses the day-mean read already done for the
   * recent average — no extra query.
   */
  series: number[];
}

/**
 * Place a recent SDNN average against a personal-baseline band. Pure. Below
 * the band's low edge → suppressed HRV ("low"); above the high edge →
 * "unbalanced" (a high excursion); within → "balanced".
 */
export function placeHrvBalance(
  recentAvg: number,
  low: number,
  high: number,
): HrvBalanceBand {
  if (recentAvg < low) return "low";
  if (recentAvg > high) return "unbalanced";
  return "balanced";
}

/**
 * The day means inside the trailing `RECENT_TREND_DAYS` before `now`. Days
 * are the UTC days the series is keyed on. The day the window opens in is
 * only partly inside it and is left out, so the window spans seven whole or
 * running days. Pure, exported for the unit test.
 */
export function recentTrendPoints(
  points: readonly DayMeanPoint[],
  now: Date,
): DayMeanPoint[] {
  const opensOn = dateOnlyKey(
    new Date(now.getTime() - RECENT_TREND_DAYS * 24 * 60 * 60 * 1000),
  );
  return points.filter((p) => p.day > opensOn);
}

/**
 * HRV (SDNN) trend / balance — reuses the flagship baseline engine for the
 * band, then places the recent 7-day average against it. Returns the
 * baseline engine's `insufficient` verbatim below the history floor so the
 * card shows the same "building your typical range — N of 7 days" state.
 */
export async function computeHrvBalance(
  userId: string,
  profile: BaselineProfile,
  opts?: { windowDays?: number; now?: Date; coverage?: RollupCoverageMap },
): Promise<Derived<HrvBalanceValue>> {
  const now = opts?.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);
  // One coverage probe shared between the baseline read below and the
  // recent-trend read (the pool-contention mitigation; the route passes a
  // pre-probed map).
  const coverageMap = opts?.coverage ?? (await probeRollupCoverage(userId));

  const baseline = await computeVitalsBaseline(userId, profile, {
    type: HRV_TYPE,
    windowDays: opts?.windowDays,
    now,
    coverage: coverageMap,
  });

  // Below the band floor (or no data) — surface the baseline engine's gated
  // result verbatim so the gating UI is identical across the two cards.
  if (!isDerivedOk(baseline)) {
    return buildInsufficient<HrvBalanceValue>({
      coverage: baseline.coverage,
      provenance: baseline.provenance,
      reason: baseline.reason,
    });
  }

  // The recent average is the mean of the DAY means of the trailing seven
  // days — the RECENT TREND, placed against the longer-window personal band.
  // Reading the band center here (an earlier behaviour) made `recentAvg`
  // identical to the band midpoint by construction, so the "low" /
  // "unbalanced" arms were dead. The window is anchored on `now`, not on the
  // newest data: the last seven day means of the series reached back as far
  // as the data did, so after a week without a sync the tile placed a
  // fortnight-old average and printed it next to a dashboard whose 7-day mean
  // covered only the readings of the past week. With no reading in the
  // trailing week the placement falls back to the band center.
  const recent = await readDayMeanSeries(
    userId,
    HRV_TYPE,
    baseline.provenance.windowDays,
    now,
    coverageMap,
  );
  const recentPoints = recentTrendPoints(recent.points, now);
  const recentAvg =
    recentPoints.length > 0
      ? recentPoints.reduce((s, p) => s + p.mean, 0) / recentPoints.length
      : baseline.value.center;
  const band = placeHrvBalance(
    recentAvg,
    baseline.value.low,
    baseline.value.high,
  );

  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: baseline.coverage.historyDays,
    missing: [],
    fullHistoryDays: baseline.provenance.windowDays,
  });

  return buildOk<HrvBalanceValue>({
    value: {
      recentAvg,
      baselineCenter: baseline.value.center,
      baselineLow: baseline.value.low,
      baselineHigh: baseline.value.high,
      band,
      sampleDays: baseline.value.sampleDays,
      series: recent.points.slice(-SPARKLINE_MAX_POINTS).map((p) => p.mean),
    },
    coverage,
    confidence,
    provenance: { ...baseline.provenance, computedAt },
  });
}
