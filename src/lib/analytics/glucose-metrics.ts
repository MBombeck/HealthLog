/**
 * Glucose clinical-metrics core — server-authoritative analytics layer.
 *
 * Pure, side-effect-free functions over an array of spot blood-glucose
 * readings (canonical **mg/dL**, the HealthLog store unit — see
 * `src/lib/glucose.ts` for unit conversion; this module never duplicates it).
 * One engine: the analytics route, the AI coach, the doctor-report PDF/FHIR
 * export, and the iOS client all read these numbers. iOS RENDERS the output,
 * it never recomputes — keeping the clinical math in one literature-locked
 * place.
 *
 * IMPORTANT honesty contract: HealthLog ingests both SPOT readings (manual
 * FASTING / POSTPRANDIAL / RANDOM / BEDTIME entries) AND, since v1.17, a dense
 * Nightscout CGM stream (~288 readings/day). The classic CGM-adequacy bar
 * (Battelino 2019: 14 days with ≥70% of possible readings) cannot be met by
 * spot data, so for a sparse series every TIR / GMI / eA1C is a SPOT-READING
 * ESTIMATE — a "% of readings" distribution, NOT a "% of time" AGP report.
 * {@link GlucoseClinicalMetrics.isSpotEstimate} is derived from reading DENSITY
 * (see {@link CGM_READINGS_PER_DAY_THRESHOLD}): a continuous CGM stream reads
 * `false` and the spot caveat comes off; sparse spot data stays `true`. The
 * {@link GlucoseClinicalMetrics.stillLearning} gate additionally holds back any
 * assertion off thin data regardless of source.
 *
 * Thresholds and formulas are clean-room from the primary literature (the
 * consensus band values and coefficients are mathematical facts, not
 * copyrightable). Each function cites its source inline. Defer the
 * dense-stream indices (MAGE, CONGA, MODD, ADRR, AGP, time-weighted mean) to
 * the future CGM integration — they need ordered, closely-spaced samples this
 * module deliberately does not assume.
 *
 * Citations:
 *   Battelino 2019, Diabetes Care 42(8):1593-1603, DOI 10.2337/dci19-0028.
 *   Bergenstal 2018, Diabetes Care 41(11):2275-2280, DOI 10.2337/dc18-1581.
 *   Nathan 2008 (ADAG), Diabetes Care 31(8):1473-1478, DOI 10.2337/dc08-0545.
 *   Monnier 2017, Diabetes Care 40(7):832-838, DOI 10.2337/dc16-1769.
 *   Wojcicki 1995 (J-index), Horm Metab Res 27(1):41-42, DOI 10.1055/s-2007-979906.
 *   Kovatchev 1997 (symmetrization + BGI), Diabetes Care 20(11):1655-1658,
 *     DOI 10.2337/diacare.20.11.1655; Kovatchev 2006 (LBGI/HBGI risk model),
 *     Diabetes Care 29(11):2433-2438, DOI 10.2337/dc06-1085.
 */

import { GLUCOSE_TIR_CUT_POINTS } from "@/lib/glucose";
import { standardDeviation } from "@/lib/stats/spread";
import { mean } from "@/lib/stats/central";

// ── Inputs ───────────────────────────────────────────────

/** A single spot blood-glucose reading. Value is canonical mg/dL. */
export interface GlucoseReading {
  /** When the sample was taken. */
  measuredAt: Date;
  /** Glucose value in mg/dL (HealthLog canonical store unit). */
  mgdl: number;
}

/** Options for the clinical-window computation. */
export interface GlucoseMetricsOptions {
  /**
   * Clinical reporting window in days. Default 14 — the Battelino 2019
   * consensus reporting period. Readings older than `now - windowDays` are
   * excluded. Configurable so the doctor report or a longer trend view can
   * widen it.
   */
  windowDays?: number;
  /**
   * Anchor for the window. Defaults to `new Date()`. Injectable purely to keep
   * the module deterministic under test — there is no other side effect.
   */
  now?: Date;
  /**
   * Minimum number of in-window readings before TIR/GMI/eA1C/CV are asserted
   * rather than gated behind `stillLearning`. Default 14 — roughly one reading
   * per day across the window; below this a spot-data estimate is not
   * clinically meaningful.
   */
  minReadings?: number;
  /**
   * Minimum span (first→last reading, in days) the window's readings must
   * cover. Default 7. A burst of readings inside a single day cannot stand in
   * for two weeks of glycaemic behaviour.
   */
  minSpanDays?: number;
}

// ── Consensus thresholds (Battelino 2019) ────────────────
// Bands in mg/dL. These are consensus FACTS, cited above. The values live in
// `GLUCOSE_TIR_CUT_POINTS` so the band labels a reader sees and the bands
// this engine counts are the same numbers.
const TBR_LEVEL2_MAX = GLUCOSE_TIR_CUT_POINTS.veryLow.mgdl; // very low: G < 54
const TBR_LEVEL1_MAX = GLUCOSE_TIR_CUT_POINTS.low.mgdl; // low: G < 70 (level-1 sub-band is 54–69)
const TAR_LEVEL1_MIN = GLUCOSE_TIR_CUT_POINTS.high.mgdl; // high: G > 180 (level-1 sub-band is 181–250)
const TAR_LEVEL2_MIN = GLUCOSE_TIR_CUT_POINTS.veryHigh.mgdl; // very high: G > 250
// Time-in-range target band is [70, 180] inclusive.
/** The time-in-range band, mg/dL, inclusive at both ends. */
export const TIME_IN_RANGE_MGDL = {
  low: TBR_LEVEL1_MAX,
  high: TAR_LEVEL1_MIN,
} as const;

/** Monnier 2017 variability cutoff: CV% ≥ 36 is "unstable". */
export const CV_INSTABILITY_THRESHOLD = 36;

/** Battelino 2019 reporting defaults. */
export const DEFAULT_WINDOW_DAYS = 14;

/**
 * Window the clinical glucose panel (TIR / GMI / eA1C / CV) covers wherever it
 * renders outside an ad-hoc report period — analytics route, dashboard
 * snapshot, and the Coach snapshot. Distinct from the 14-day Battelino default
 * the standalone metric reader uses; one export so the "same number
 * everywhere" guarantee doesn't depend on hand-synced literals. The doctor PDF
 * deliberately uses the report period instead and does NOT read this.
 */
export const GLUCOSE_PANEL_WINDOW_DAYS = 30;
const DEFAULT_MIN_READINGS = 14;
const DEFAULT_MIN_SPAN_DAYS = 7;

/**
 * Readings-per-day at or above which the series is treated as a CONTINUOUS
 * stream (a CGM such as Nightscout, ~288/day) rather than spot fingersticks (a
 * handful/day). Roughly hourly — wide enough that a real CGM (≈288/day) clears
 * it by an order of magnitude while no realistic spot-checking cadence reaches
 * it. Above the threshold the TIR/GMI/eA1C are no longer framed as a
 * spot-reading estimate (`isSpotEstimate: false`); below it the conservative
 * spot caveat stays.
 */
const CGM_READINGS_PER_DAY_THRESHOLD = 24;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Output shapes ────────────────────────────────────────

/**
 * Battelino 2019 time-in-range distribution as fractions of readings (0–1).
 * `*Minutes` carry the minutes-equivalent over a 24h day (fraction × 1440) so
 * the UI can echo the consensus "<N min/day" goals; these are minutes-OF-A-DAY
 * equivalents of a per-reading distribution, NOT measured time-on-CGM.
 */
export interface TimeInRangeDistribution {
  /** % readings 70 ≤ G ≤ 180. Goal > 0.70. */
  tir: number;
  /** % readings G < 70 (includes the very-low sub-band). Goal < 0.04. */
  tbrLevel1: number;
  /** % readings G < 54. Goal < 0.01. */
  tbrLevel2: number;
  /** % readings G > 180 (includes the very-high sub-band). Goal < 0.25. */
  tarLevel1: number;
  /** % readings G > 250. Goal < 0.05. */
  tarLevel2: number;
  /** Minutes-of-a-day equivalents (fraction × 1440). */
  minutesEquivalent: {
    tir: number;
    tbrLevel1: number;
    tbrLevel2: number;
    tarLevel1: number;
    tarLevel2: number;
  };
}

/** Variability summary: SD + CV% with the Monnier stability flag. */
export interface GlucoseVariability {
  /** Sample standard deviation (n−1), mg/dL. */
  sd: number;
  /** Coefficient of variation, percent: SD / mean × 100. */
  cv: number;
  /** True when CV% ≥ 36 (Monnier 2017 instability cutoff). */
  unstable: boolean;
}

/** The full clinical-metrics result for a window of spot readings. */
export interface GlucoseClinicalMetrics {
  /**
   * When true, the window has too few readings or too short a span to assert a
   * clinically meaningful estimate. The numeric fields below are still
   * populated from whatever data exists (so a calm preview can render) but MUST
   * NOT be presented as a clinical assessment. The UI should render a
   * "still learning — N readings over D days" state.
   */
  stillLearning: boolean;
  /** Human/UI-facing reason for the gate (null once it clears). */
  stillLearningReason: string | null;

  /** Declared clinical window in days (the requested `windowDays`). */
  windowDays: number;
  /** Actual span the in-window readings cover (first→last), in days. */
  actualSpanDays: number;
  /** Number of readings used (those falling inside the window). */
  readingCount: number;

  /** Arithmetic mean glucose over the window, mg/dL (null if no readings). */
  meanMgdl: number | null;

  /** Battelino 2019 TIR/TBR/TAR distribution (null if no readings). */
  distribution: TimeInRangeDistribution | null;
  /** Bergenstal 2018 Glucose Management Indicator, percent (null if no data). */
  gmi: number | null;
  /** Nathan 2008 estimated A1C, percent (null if no data). */
  estimatedA1c: number | null;
  /** SD + CV% + instability flag (null if < 2 readings). */
  variability: GlucoseVariability | null;

  /**
   * Advanced indices (J-index + LBGI/HBGI). Null when there are no readings;
   * the J-index additionally needs ≥ 2 readings (it consumes the sample SD), so
   * `jIndex` is held back to null inside the object when only one reading
   * exists. Shown behind the panel's "advanced" disclosure.
   */
  advanced: {
    jIndex: number | null;
    lbgi: number;
    hbgi: number;
  } | null;

  /**
   * Whether every number here should be framed as a SPOT-READING ESTIMATE (a
   * "% of readings") rather than a CGM time-in-range AGP. Derived from reading
   * DENSITY, not hard-coded: a continuous stream (a Nightscout CGM at ~288
   * readings/day) clears the {@link CGM_READINGS_PER_DAY_THRESHOLD} hourly bar
   * and reports `false`; sparse spot fingersticks stay `true`. Surfaced
   * explicitly so serializers (panel/coach/PDF/iOS) carry the caveat without
   * re-deriving it.
   */
  isSpotEstimate: boolean;
}

// ── Core formulas ────────────────────────────────────────

/**
 * Sample standard deviation, sqrt(Σ(Gᵢ−mean)² / (n−1)).
 * Standard variability foundation reported alongside mean in Battelino 2019.
 * Returns null for n < 2 (undefined sample SD).
 */
export function glucoseSD(values: number[]): number | null {
  return standardDeviation(values, "sample");
}

/**
 * Coefficient of variation (%) with the Monnier 2017 instability flag.
 * %CV = SD / mean × 100; CV% ≥ 36 → unstable.
 * Monnier 2017, Diabetes Care 40(7):832-838, DOI 10.2337/dc16-1769;
 * endorsed in Battelino 2019.
 */
export function glucoseVariability(
  values: number[],
): GlucoseVariability | null {
  const sd = glucoseSD(values);
  if (sd === null) return null;
  const m = mean(values)!;
  if (m === 0) return null;
  const cv = (sd / m) * 100;
  return { sd, cv, unstable: cv >= CV_INSTABILITY_THRESHOLD };
}

/**
 * Glucose Management Indicator (GMI), percent, from mean glucose in mg/dL.
 * GMI% = 3.31 + 0.02392 × mean(mg/dL).
 * Bergenstal 2018, Diabetes Care 41(11):2275-2280, DOI 10.2337/dc18-1581.
 */
export function gmi(meanMgdl: number): number {
  return 3.31 + 0.02392 * meanMgdl;
}

/**
 * Estimated A1C (%) from mean glucose in mg/dL (ADAG inverse of eAG).
 * eAG = 28.7 × A1C − 46.7  ⇒  A1C% = (mean + 46.7) / 28.7.
 * Nathan 2008 (ADAG), Diabetes Care 31(8):1473-1478, DOI 10.2337/dc08-0545.
 * Preferred for spot/SMBG data; GMI is the CGM-native sibling.
 */
export function estimatedA1c(meanMgdl: number): number {
  return (meanMgdl + 46.7) / 28.7;
}

/**
 * J-index — a single composite of central tendency and variability:
 *   J = 0.001 × (mean + SD)²,   both in mg/dL.
 * Returns null for n < 2 (the sample SD is undefined). Approximation bands are
 * documented on {@link GlucoseAdvancedIndices.jIndex}.
 * Wojcicki 1995, Horm Metab Res 27(1):41-42, DOI 10.1055/s-2007-979906.
 */
export function jIndex(values: number[]): number | null {
  const sd = glucoseSD(values);
  if (sd === null) return null;
  const m = mean(values)!;
  const s = m + sd;
  return 0.001 * s * s;
}

/**
 * Kovatchev symmetrization transform for a single mg/dL reading:
 *   f(BG) = 1.509 × ( (ln BG)^1.084 − 5.381 ).
 * The transform maps the asymmetric mg/dL scale onto a symmetric axis where
 * the clinical centre (~112.5 mg/dL) is 0; lows go negative, highs positive.
 * Kovatchev 1997, Diabetes Care 20(11):1655-1658,
 * DOI 10.2337/diacare.20.11.1655.
 */
function kovatchevSymmetrize(bgMgdl: number): number {
  return 1.509 * (Math.pow(Math.log(bgMgdl), 1.084) - 5.381);
}

/**
 * Low / High Blood Glucose Index (LBGI / HBGI) — Kovatchev risk model.
 * Per reading the risk is `r(BG) = 10 × f(BG)²` (f = symmetrization above);
 * it is assigned to the LOW branch when f < 0 and the HIGH branch when f > 0
 * (f = 0 contributes 0 to both). LBGI = mean of the low-branch risks across
 * ALL readings (zeros included), HBGI = mean of the high-branch risks.
 * Readings ≤ 0 mg/dL (ln undefined) are skipped from the denominator.
 * Returns null when no usable reading remains.
 * Kovatchev 2006, Diabetes Care 29(11):2433-2438, DOI 10.2337/dc06-1085.
 */
export function bloodGlucoseRiskIndices(
  values: number[],
): { lbgi: number; hbgi: number } | null {
  let lowSum = 0;
  let highSum = 0;
  let n = 0;
  for (const bg of values) {
    if (!Number.isFinite(bg) || bg <= 0) continue;
    const f = kovatchevSymmetrize(bg);
    const r = 10 * f * f;
    if (f < 0) {
      lowSum += r;
    } else if (f > 0) {
      highSum += r;
    }
    // f === 0 contributes 0 to both branches but still counts in n.
    n += 1;
  }
  if (n === 0) return null;
  return { lbgi: lowSum / n, hbgi: highSum / n };
}

/**
 * Time-in-range distribution over the Battelino 2019 consensus bands, as
 * fractions of readings (NOT % of time — spot data, labelled honestly).
 *   TIR  : 70 ≤ G ≤ 180     (goal > 0.70)
 *   TBR1 : G < 70           (goal < 0.04)
 *   TBR2 : G < 54           (goal < 0.01)
 *   TAR1 : G > 180          (goal < 0.25)
 *   TAR2 : G > 250          (goal < 0.05)
 * TBR2 ⊆ TBR1 and TAR2 ⊆ TAR1 (the consensus reports level-2 as a sub-band of
 * level-1), so the five fractions are NOT mutually exclusive by design.
 * Battelino 2019, Diabetes Care 42(8):1593-1603, DOI 10.2337/dci19-0028.
 */
export function timeInRange(values: number[]): TimeInRangeDistribution | null {
  const n = values.length;
  if (n === 0) return null;

  let inRange = 0;
  let below70 = 0;
  let below54 = 0;
  let above180 = 0;
  let above250 = 0;

  for (const g of values) {
    if (g < TBR_LEVEL1_MAX) {
      below70 += 1;
      if (g < TBR_LEVEL2_MAX) below54 += 1;
    } else if (g > TAR_LEVEL1_MIN) {
      above180 += 1;
      if (g > TAR_LEVEL2_MIN) above250 += 1;
    } else {
      // 70 ≤ G ≤ 180
      inRange += 1;
    }
  }

  const tir = inRange / n;
  const tbrLevel1 = below70 / n;
  const tbrLevel2 = below54 / n;
  const tarLevel1 = above180 / n;
  const tarLevel2 = above250 / n;
  const MIN_PER_DAY = 1440;

  return {
    tir,
    tbrLevel1,
    tbrLevel2,
    tarLevel1,
    tarLevel2,
    minutesEquivalent: {
      tir: tir * MIN_PER_DAY,
      tbrLevel1: tbrLevel1 * MIN_PER_DAY,
      tbrLevel2: tbrLevel2 * MIN_PER_DAY,
      tarLevel1: tarLevel1 * MIN_PER_DAY,
      tarLevel2: tarLevel2 * MIN_PER_DAY,
    },
  };
}

// ── Window + adequacy orchestration ──────────────────────

/**
 * Compute the full clinical-metrics panel for a set of spot readings.
 *
 * Pins a declared clinical window (default 14d, Battelino 2019), reports the
 * actual span + reading count used, and applies the learning/adequacy gate so
 * the caller never presents a thin-data estimate as a clinical assessment.
 *
 * Pure: no Prisma, no I/O. `now` is injectable for deterministic tests.
 */
export function computeGlucoseClinicalMetrics(
  readings: GlucoseReading[],
  options: GlucoseMetricsOptions = {},
): GlucoseClinicalMetrics {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? new Date();
  const minReadings = options.minReadings ?? DEFAULT_MIN_READINGS;
  const minSpanDays = options.minSpanDays ?? DEFAULT_MIN_SPAN_DAYS;

  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const inWindow = readings
    .filter(
      (r) =>
        r.measuredAt.getTime() >= cutoff &&
        r.measuredAt.getTime() <= now.getTime() &&
        Number.isFinite(r.mgdl) &&
        // Non-positive glucose is non-physiological and ln-undefined (the
        // Kovatchev symmetrization needs ln BG). Excluding it here keeps EVERY
        // index — mean / SD / TIR / GMI / LBGI / HBGI — on one shared
        // denominator rather than letting the risk indices drop a row the
        // others kept.
        r.mgdl > 0,
    )
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());

  const readingCount = inWindow.length;
  const actualSpanDays =
    readingCount >= 2
      ? (inWindow[readingCount - 1].measuredAt.getTime() -
          inWindow[0].measuredAt.getTime()) /
        MS_PER_DAY
      : 0;

  const values = inWindow.map((r) => r.mgdl);
  const meanMgdl = mean(values);

  const distribution = timeInRange(values);
  const variability = glucoseVariability(values);
  const gmiValue = meanMgdl !== null ? gmi(meanMgdl) : null;
  const eA1cValue = meanMgdl !== null ? estimatedA1c(meanMgdl) : null;

  // Advanced indices — null when no readings. The risk indices need ≥ 1 usable
  // reading; the J-index needs ≥ 2 (sample SD), so it is held to null inside
  // the object for a single-reading window while LBGI/HBGI still resolve.
  const risk = bloodGlucoseRiskIndices(values);
  const advanced =
    risk !== null
      ? {
          jIndex: jIndex(values),
          lbgi: risk.lbgi,
          hbgi: risk.hbgi,
        }
      : null;

  // Learning/adequacy gate. Spot data cannot meet the CGM adequacy bar; this
  // is the honest "is the estimate worth asserting yet" check. Order matters:
  // report the most actionable reason first.
  let stillLearning = false;
  let stillLearningReason: string | null = null;

  if (readingCount === 0) {
    stillLearning = true;
    stillLearningReason = `No glucose readings in the last ${windowDays} days.`;
  } else if (readingCount < minReadings) {
    stillLearning = true;
    stillLearningReason = `Still learning — ${readingCount} reading${
      readingCount === 1 ? "" : "s"
    } over ${roundSpan(actualSpanDays)} day${
      roundSpan(actualSpanDays) === 1 ? "" : "s"
    }; at least ${minReadings} are needed for a meaningful estimate.`;
  } else if (actualSpanDays < minSpanDays) {
    stillLearning = true;
    stillLearningReason = `Still learning — readings span only ${roundSpan(
      actualSpanDays,
    )} day${
      roundSpan(actualSpanDays) === 1 ? "" : "s"
    }; at least ${minSpanDays} days of coverage are needed.`;
  }

  // Density-derived spot vs continuous framing. Readings/day = count over the
  // covered span (floored at one day so a single-day burst can't divide by a
  // sub-day span and look continuous). At or above the hourly CGM bar the
  // series is a continuous stream and the spot-reading caveat comes off.
  const readingsPerDay = readingCount / Math.max(actualSpanDays, 1);
  const isSpotEstimate = readingsPerDay < CGM_READINGS_PER_DAY_THRESHOLD;

  return {
    stillLearning,
    stillLearningReason,
    windowDays,
    actualSpanDays,
    readingCount,
    meanMgdl,
    distribution,
    gmi: gmiValue,
    estimatedA1c: eA1cValue,
    variability,
    advanced,
    isSpotEstimate,
  };
}

/** Round a span to whole days for the human-facing learning message. */
function roundSpan(spanDays: number): number {
  return Math.max(0, Math.round(spanDays));
}
