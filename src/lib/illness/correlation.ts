/**
 * Illness correlation + recovery-gap engine (v1.18.1, Workstream B / P3).
 *
 * Server-authoritative, reliability-first. Given ONE illness episode this
 * assembles three retrospective findings — never a prediction, never a
 * diagnosis — each gated by the shared coverage/confidence model so a thin
 * signal asserts NOTHING:
 *
 *   1. **Pre-onset anomaly scan** — the N days BEFORE onset, each tracked
 *      vital's deviation in robust SDs from the user's OWN baseline (median
 *      ± MAD, the same `computeVitalsBaseline` engine), the baseline computed
 *      from a window that ENDS before the pre-onset lookback so the episode's
 *      own physiology can never poison the baseline it is measured against.
 *      "How did it announce itself?"
 *   2. **Nadir / what-dropped** — across the episode's active span, the
 *      furthest each vital strayed from baseline (the nadir day + magnitude +
 *      direction). "What dropped."
 *   3. **Recovery-gap** — the intellectual core: physiological return-to-
 *      baseline (first day a previously-deviated vital re-enters its band and
 *      STAYS in for `RETURN_STABILITY_DAYS`) vs the felt-better marker
 *      (`resolvedAt`). The gap is `physiologicalReturn − feltBetter` in days:
 *      positive = the body lagged the feeling (you felt better before your
 *      numbers did), negative = numbers normalised first. CHRONIC_ONGOING is
 *      excluded (no recovered date).
 *
 * The directionality of "worse" is metric-specific (a HRV/recovery DROP and a
 * resting-HR/temperature RISE both mean "stressed"); `ADVERSE_DIRECTION`
 * pins it per metric. Red-flag patterns (a sustained large oxygen-saturation
 * drop, a sustained fever) ESCALATE to a "seek care" flag — never reassure.
 *
 * Pure given its inputs: the caller does the bounded reads (baseline series +
 * per-day vital means within the episode window) and passes them in, so the
 * whole engine is unit-testable against golden fixtures with no DB. The route
 * wires the reads; the parity test asserts the rollup-fed path and a raw-SQL
 * path agree.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { FEVER_RED_FLAG_C, SPO2_RED_FLAG_PCT } from "@/lib/clinical-floors";
import { buildBaselineBand } from "@/lib/insights/derived/baseline";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "@/lib/insights/derived/coverage";
import type { Derived } from "@/lib/insights/derived/types";
import { daysBetweenDateKeys } from "@/lib/tz/format";
import { median } from "@/lib/stats/central";

/* ── tunables (documented invariants) ────────────────────────────────── */

/** Days before onset scanned for the "how did it announce itself" signal. */
export const PRE_ONSET_LOOKBACK_DAYS = 7;
/** Trailing baseline window (days), ending BEFORE the pre-onset lookback. */
export const BASELINE_WINDOW_DAYS = 30;
/**
 * Minimum distinct baseline days a vital needs before we trust its band.
 * Mirrors `computeVitalsBaseline`'s 7-day floor — below this the vital is
 * dropped from the scan rather than asserted on a fragile band.
 */
export const MIN_BASELINE_DAYS = 7;
/**
 * A deviation of ≥ this many robust SDs (k·MAD·scale units) from baseline
 * counts as "notable" for the pre-onset + nadir surfaces. ~2σ-equivalent.
 */
export const NOTABLE_SD = 2;
/**
 * Consecutive in-band days required to call a vital "returned to baseline"
 * for the recovery-gap (one lucky in-band day is not a recovery).
 */
export const RETURN_STABILITY_DAYS = 3;
/**
 * Sentinel `type` for the functional-impact return track. The symptom curve is
 * NOT a `MeasurementType` — it is the user's own logged daily-impact slider —
 * so it rides `returns[]` under a stable string key the surface keys copy off
 * (the typed `VitalReturnFinding.type` is widened to accept it). Tallied like
 * any vital type in `gapReturnTypes` so it can win `gapDriverType`.
 */
export const FUNCTIONAL_IMPACT_RETURN_KEY = "FUNCTIONAL_IMPACT" as const;
/**
 * Functional-impact threshold (0–3 slider) at/above which a logged day counts
 * as ADVERSE (symptomatic). The baseline is the known constant 0 (healthy), so
 * the symptom curve needs none of the MAD-band / contamination machinery the
 * passive vitals carry — "return" is simply impact back to below this floor.
 */
export const FUNCTIONAL_IMPACT_ADVERSE_FLOOR = 1;
/** Minimum episode days with ANY vital coverage before the gap is asserted. */
export const MIN_EPISODE_COVERAGE_DAYS = 4;
/**
 * Minimum scorable baseline nights before the sleep-context observation is
 * trusted (mirrors the sleep-debt engine's `minNights` floor). Below this the
 * "usual" asleep figure is too fragile to compare against.
 */
export const SLEEP_CONTEXT_MIN_BASELINE_NIGHTS = 4;
/** Minimum scorable episode nights before the sleep-context line surfaces. */
export const SLEEP_CONTEXT_MIN_EPISODE_NIGHTS = 3;
/**
 * Minimum |episode − baseline| asleep-minutes delta before the sleep-context
 * line is shown. Day-to-day jitter below this floor is not narrated as a
 * finding (honest withholding, never a fabricated observation).
 */
export const SLEEP_CONTEXT_MIN_DELTA_MINUTES = 30;

/**
 * Per-metric adverse direction — which way a reading moves when the body is
 * under illness stress. `up` = a RISE is adverse (resting HR, temperature,
 * respiratory rate, BP); `down` = a DROP is adverse (HRV, recovery, SpO2).
 * Weight/glucose have no single illness-adverse direction → omitted (their
 * deviation magnitude is still surfaced, direction stays neutral).
 */
export const ADVERSE_DIRECTION: Partial<
  Record<MeasurementType, "up" | "down">
> = {
  RESTING_HEART_RATE: "up",
  PULSE: "up",
  BODY_TEMPERATURE: "up",
  SKIN_TEMPERATURE: "up",
  RESPIRATORY_RATE: "up",
  BLOOD_PRESSURE_SYS: "up",
  BLOOD_PRESSURE_DIA: "up",
  HEART_RATE_VARIABILITY: "down",
  HRV_RMSSD: "down",
  RECOVERY_SCORE: "down",
  OXYGEN_SATURATION: "down",
};

/**
 * Vitals scanned by the illness engine. Superset of the typical-range set
 * plus RECOVERY_SCORE (a canonical wellness signal). The caller only passes
 * series for the vitals the user actually tracks; the rest are skipped.
 */
export const ILLNESS_SCAN_TYPES: MeasurementType[] = [
  "RESTING_HEART_RATE",
  "HEART_RATE_VARIABILITY",
  // RMSSD, scanned on its own baseline: a nightly strap or ring reading drops
  // during illness the same way SDNN does.
  "HRV_RMSSD",
  "RECOVERY_SCORE",
  "OXYGEN_SATURATION",
  "BODY_TEMPERATURE",
  "RESPIRATORY_RATE",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "WEIGHT",
];

/* ── inputs the caller resolves and passes in (pure engine) ──────────── */

/** A per-day mean for one vital (YYYY-MM-DD local day → mean). */
export interface VitalDayPoint {
  /** Local day key, `YYYY-MM-DD`. */
  day: string;
  /** Mean reading for the day. */
  mean: number;
}

/**
 * Everything the engine needs for ONE vital: the baseline-window series
 * (ENDS before the pre-onset lookback — contamination guard lives in the
 * caller's read window) and the episode-window series (pre-onset lookback
 * through the felt-better marker, inclusive).
 */
export interface VitalSeries {
  type: MeasurementType;
  /** Per-day means over the clean baseline window (no episode-span days). */
  baselineDays: VitalDayPoint[];
  /** Per-day means from `onset − lookback` through `resolvedAt` (or today). */
  episodeDays: VitalDayPoint[];
  /**
   * Per-day MAX readings over the episode window, used by the fever red-flag
   * so an evening spike averaged toward normal in `episodeDays` (which carries
   * means) is not masked. Optional — when omitted the flag falls back to the
   * mean series. SpO2 stays mean/min-based (its `worst` is `min`).
   */
  episodeDayMax?: VitalDayPoint[];
}

/**
 * A user-logged fever reading from the illness day-log (`feverC`), keyed by
 * the same local day key as the vital series. The fever red-flag unions this
 * with any passive BODY_TEMPERATURE series so a user logging 39.2 °C for days
 * with no HealthKit thermometer still escalates. Per-day MAX semantics.
 */
export interface DayLogFeverPoint {
  /** Local day key, `YYYY-MM-DD`. */
  day: string;
  /** Logged fever in °C (the day's max when several were logged). */
  feverC: number;
}

/**
 * A user-logged symptom-burden reading from the illness day-log, keyed by the
 * stored `date` (already the user-tz local day). `impact` is the day's
 * `functionalImpact` slider (0–3, 0 = fully functional … 3 = bedbound); when
 * NULL it is the day's max linked `IllnessSymptomLink.severity` (0–3) as a
 * fallback corroborator, or null when neither was logged. Present days only —
 * never zero-filled (mirrors the fever read), so sparse logging WITHHOLDS the
 * symptom return rather than fabricating an all-clear from absence of rows.
 */
export interface SymptomBurdenPoint {
  /** Local day key, `YYYY-MM-DD`. */
  day: string;
  /** The day's symptom burden (0–3): functionalImpact, else max severity. */
  impact: number;
}

/**
 * One reconstructed night's asleep total, keyed by the local WAKE-DAY (the same
 * `YYYY-MM-DD` day-space the engine's onset/feltBetter markers live in — a
 * canonical `NightSummary.night`). The caller reconstructs nights from the raw
 * per-stage SLEEP_DURATION rows (writer-deduped, session-clustered) and passes
 * the asleep totals in; the engine never touches raw rows. Used ONLY for the
 * sleep-context observation, NEVER as a recovery-gap return track.
 */
export interface SleepNightPoint {
  /** Local wake-day key, `YYYY-MM-DD`. */
  day: string;
  /** Asleep minutes for the night (canonical, multi-source-deduped). */
  asleepMinutes: number;
}

/** The dates the engine reasons over, all `YYYY-MM-DD` local day keys. */
export interface EpisodeWindow {
  /** Onset day. */
  onsetDay: string;
  /** Felt-better marker (resolvedAt local day), or null when still active. */
  feltBetterDay: string | null;
  /** Lifecycle — CHRONIC_ONGOING suppresses the recovery-gap. */
  lifecycle: string;
}

export interface IllnessCorrelationInput {
  episodeId: string;
  window: EpisodeWindow;
  /** One entry per vital the user tracks (others omitted by the caller). */
  series: VitalSeries[];
  /**
   * Per-day fever readings from the illness day-log (`feverC`). Unioned into
   * the fever red-flag so the canonical journaling-fever path is visible to
   * escalation even with no passive BODY_TEMPERATURE rows. Optional.
   */
  dayLogFever?: DayLogFeverPoint[];
  /**
   * Per-day symptom-burden readings from the illness day-log (`functionalImpact`
   * primary, max linked symptom `severity` as fallback). Folded into the
   * recovery-gap as ONE more return track against the known-constant baseline
   * (healthy = 0): a "symptom return" is the burden back below the adverse floor
   * and held for `RETURN_STABILITY_DAYS` LOGGED days. Always `adverse:true` (it
   * is illness-relevant by construction), so it contributes to
   * `adverseCoverageDays` and can drive the headline gap even on a
   * passive-vital-thin episode. Optional.
   */
  symptomBurden?: SymptomBurdenPoint[];
  /**
   * Reconstructed per-night asleep totals over the user's WELL baseline window
   * (the span ending before the pre-onset lookback). Their median is the user's
   * usual asleep figure the episode is compared against. Optional — absent /
   * thin → no sleep-context observation. NEVER feeds the recovery-gap.
   */
  baselineNights?: SleepNightPoint[];
  /**
   * Reconstructed per-night asleep totals over the episode window (`onset −
   * lookback` through end). Compared against the baseline median as a neutral
   * CONTEXT observation (slept more / less than usual), never a return track and
   * never in the gap median. Optional — absent / thin → no observation.
   */
  episodeNights?: SleepNightPoint[];
  /** Provenance source the dominant read resolved against. */
  source: "DAY" | "live" | "none";
  /** Compute time (injected for deterministic tests). */
  now?: Date;
}

/* ── output value (the server-authoritative DTO payload) ─────────────── */

/** One vital's deviation finding on a given day. */
export interface VitalDeviationFinding {
  type: MeasurementType;
  /** The day this finding describes (`YYYY-MM-DD`). */
  day: string;
  /** The day's mean reading. */
  value: number;
  /** Robust baseline center the deviation is measured from. */
  baselineCenter: number;
  /** Signed deviation in robust-SD (k·MAD·scale) units; +above / −below. */
  deviationSd: number;
  /** Which way the reading moved. */
  direction: "above" | "below";
  /** True when this move is the illness-adverse direction for the metric. */
  adverse: boolean;
}

/** A vital's recovery timing within the episode. */
export interface VitalReturnFinding {
  /**
   * The metric the return describes — a `MeasurementType` for a passive vital,
   * or `FUNCTIONAL_IMPACT_RETURN_KEY` for the user-logged symptom-burden track.
   */
  type: MeasurementType | typeof FUNCTIONAL_IMPACT_RETURN_KEY;
  /** First day the vital re-entered its band AND stayed in for the window. */
  returnedDay: string | null;
  /** Days from felt-better to physiological return (signed); null if N/A. */
  gapDays: number | null;
  /** Whether this vital deviated in the illness-adverse direction during the
   *  active span — a neutral move (e.g. weight drift with no adverse signal)
   *  still produces a return but must not name the recovery driver. */
  adverse: boolean;
}

/**
 * Whether a banded reading is the illness-adverse move for its metric — a
 * RISE for an "up"-adverse vital (resting HR, temperature, BP, …), a DROP for
 * a "down"-adverse one (HRV, recovery, SpO2). The single adverse-direction
 * predicate the engine reasons with; reused by the qualifying-days floor so a
 * neutral-direction vital (WEIGHT, glucose) never counts a day toward it.
 */
export function isAdverseDeviation(
  type: MeasurementType,
  direction: "above" | "below",
): boolean {
  const adverseDir = ADVERSE_DIRECTION[type];
  return (
    (adverseDir === "up" && direction === "above") ||
    (adverseDir === "down" && direction === "below")
  );
}

/**
 * A neutral sleep-context observation for the episode — the user's median
 * asleep minutes over the well baseline vs the mean over the episode window. A
 * pure OBSERVATION ("you slept more / less than usual"), never a recovery
 * return, never in the gap median, never a causal/recovery claim. Null when the
 * sleep data is too thin (below the night-count floors) or the delta is below
 * the magnitude floor — honest withholding, never a fabricated finding.
 */
export interface SleepContext {
  /** Median asleep minutes over the well baseline window. */
  baselineMeanMinutes: number;
  /** Mean asleep minutes over the episode window. */
  episodeMeanMinutes: number;
  /** `episode − baseline` asleep minutes (positive = slept more than usual). */
  deltaMinutes: number;
  /** Scorable episode nights the observation is built from (transparency). */
  nightsCounted: number;
}

export interface IllnessCorrelationValue {
  episodeId: string;
  /** "How did it announce itself" — notable pre-onset deviations. */
  preOnset: VitalDeviationFinding[];
  /** "What dropped" — each vital's worst (nadir) deviation in the episode. */
  nadir: VitalDeviationFinding[];
  /** Per-vital physiological-return timing. */
  returns: VitalReturnFinding[];
  /**
   * The headline recovery-gap in days (median of the per-vital gaps), or
   * null when CHRONIC_ONGOING / still active / no vital returned. Positive
   * = the body lagged the felt-better marker.
   */
  recoveryGapDays: number | null;
  /**
   * Distinct episode days carrying at least one ADVERSE-direction banded
   * reading (a vital moving the illness-adverse way for its metric). This is
   * the qualifying-days floor the cross-episode aggregate gates the typical-
   * gap median on — a WEIGHT-only (no adverse direction) episode contributes
   * 0 here even when `coverage.historyDays` (any banded reading) is high, so
   * an episode with no illness-relevant signal cannot tip the typical gap.
   */
  adverseCoverageDays: number;
  /** Felt-better marker echoed for the surface. */
  feltBetterDay: string | null;
  /**
   * The metric whose physiological return dominates the headline gap — the
   * adverse return-track whose own gap is closest to the median, with the
   * functional-impact symptom track winning ties (it is the most
   * illness-specific signal). A `MeasurementType`,
   * `FUNCTIONAL_IMPACT_RETURN_KEY`, or null when no adverse return drove a gap.
   * The card names it ("…before your symptoms eased" vs "…before your resting
   * heart rate settled"). Retrospective only.
   */
  gapDriverType: string | null;
  /**
   * Red-flag escalation — a sustained adverse SpO2 drop or sustained fever
   * during the episode. Retrospective, but the copy must escalate ("if this
   * recurs, seek care"), NEVER reassure. Empty when nothing tripped.
   */
  redFlags: IllnessRedFlag[];
  /**
   * Sleep-as-context observation — slept more / less than usual during the
   * episode — or null when the sleep data is too thin or the delta sub-floor.
   * A neutral observation surfaced ALONGSIDE the gap, NEVER a return track and
   * NEVER part of the headline recovery-gap number. Optional/additive.
   */
  sleepContext: SleepContext | null;
}

export interface IllnessRedFlag {
  type: MeasurementType;
  /** A short stable reason key the i18n layer renders (not free text). */
  reason: "sustained_low_spo2" | "sustained_fever";
  /** The worst observed value during the flagged run. */
  worstValue: number;
  /** Consecutive days the adverse threshold held. */
  days: number;
}

/* ── red-flag thresholds (clinical floors, conservative) ─────────────── */

// D3-H1: sustained-fever + sustained-low-SpO2 escalation floors come from the
// one source of truth so the illness engine, the status registry's fever band,
// and the hero/Coach never carry divergent magic numbers.
/** SpO2 at/below this for ≥ RED_FLAG_RUN_DAYS escalates. */
const SPO2_RED_FLAG = SPO2_RED_FLAG_PCT;
/** Body temperature at/above this (°C) for ≥ RED_FLAG_RUN_DAYS escalates. */
const FEVER_RED_FLAG = FEVER_RED_FLAG_C;
/**
 * Consecutive days an adverse clinical threshold must hold to escalate.
 * Exported so the on-write safety seam (`safety-floor-check.ts`) escalates a
 * sustained fever / low-SpO2 run on ingest using the SAME run length as this
 * retrospective detector — the two paths can never disagree on what "sustained"
 * means.
 */
export const RED_FLAG_RUN_DAYS = 3;

/* ── pure helpers ─────────────────────────────────────────────────────── */

/** Robust band for a vital, or null below the min-baseline-days floor. */
function bandFor(series: VitalSeries): {
  center: number;
  spread: number;
} | null {
  if (series.baselineDays.length < MIN_BASELINE_DAYS) return null;
  const band = buildBaselineBand(
    series.baselineDays.map((p) => p.mean),
    series.type,
  );
  if (!band || band.spread <= 0) return null;
  return { center: band.center, spread: band.spread };
}

/** Signed deviation of a value in robust-SD units (spread = k·MAD·scale). */
function deviationSd(value: number, center: number, spread: number): number {
  return (value - center) / spread;
}

/** Build a deviation finding for one day/value against a band. */
function finding(
  type: MeasurementType,
  day: string,
  value: number,
  center: number,
  spread: number,
): VitalDeviationFinding {
  const sd = deviationSd(value, center, spread);
  const direction: "above" | "below" = sd >= 0 ? "above" : "below";
  const adverse = isAdverseDeviation(type, direction);
  return {
    type,
    day,
    value,
    baselineCenter: center,
    deviationSd: Math.round(sd * 100) / 100,
    direction,
    adverse,
  };
}

/** Order day keys chronologically. */
function byDay(a: { day: string }, b: { day: string }): number {
  return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
}

/* ── the engine ───────────────────────────────────────────────────────── */

/**
 * Compute the retrospective correlation findings for one episode. Pure given
 * its inputs — the caller resolves the reads (rollup tier with a live-SQL
 * fallback) and passes the series in. Returns a gated `Derived<T>`: below the
 * coverage floor it returns `insufficient` (never a fabricated finding).
 */
export function computeIllnessCorrelation(
  input: IllnessCorrelationInput,
): Derived<IllnessCorrelationValue> {
  const now = input.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);
  const { window } = input;

  // Only vitals with a trustworthy own-baseline band participate.
  const banded = input.series
    .map((s) => ({ series: s, band: bandFor(s) }))
    .filter(
      (
        b,
      ): b is {
        series: VitalSeries;
        band: { center: number; spread: number };
      } => b.band !== null,
    );

  const inputs = banded.map((b) => String(b.series.type));
  const provenance = {
    inputs,
    source: input.source,
    windowDays: BASELINE_WINDOW_DAYS,
    computedAt,
  };

  // Coverage: how many distinct episode days carry ANY banded vital reading.
  const episodeDayKeys = new Set<string>();
  for (const b of banded) {
    for (const p of b.series.episodeDays) {
      if (p.day >= window.onsetDay) episodeDayKeys.add(p.day);
    }
  }
  const coverageDays = episodeDayKeys.size;

  if (banded.length === 0 || coverageDays < MIN_EPISODE_COVERAGE_DAYS) {
    const { coverage } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: banded.length,
      historyDays: coverageDays,
      missing: banded.length === 0 ? ILLNESS_SCAN_TYPES.map(String) : [],
      fullHistoryDays: MIN_EPISODE_COVERAGE_DAYS,
    });
    return buildInsufficient<IllnessCorrelationValue>({
      coverage,
      provenance,
      reason:
        banded.length === 0
          ? "no_baselined_vitals"
          : "insufficient_episode_coverage",
    });
  }

  const preOnset: VitalDeviationFinding[] = [];
  const nadir: VitalDeviationFinding[] = [];
  const returns: VitalReturnFinding[] = [];
  // Distinct active-span days with at least one notable ADVERSE-direction
  // banded reading. This — not raw `coverageDays` (any banded reading) — is
  // the qualifying-days floor the cross-episode aggregate gates on, so a
  // neutral-direction-only episode (e.g. WEIGHT) never feeds the typical gap.
  const adverseDayKeys = new Set<string>();

  for (const { series, band } of banded) {
    const { type } = series;
    const { center, spread } = band;
    const episode = [...series.episodeDays].sort(byDay);

    // 1) Pre-onset scan: lookback window strictly before onset.
    const pre = episode.filter((p) => p.day < window.onsetDay);
    let worstPre: VitalDeviationFinding | null = null;
    for (const p of pre) {
      const f = finding(type, p.day, p.mean, center, spread);
      if (
        Math.abs(f.deviationSd) >= NOTABLE_SD &&
        (worstPre === null ||
          Math.abs(f.deviationSd) > Math.abs(worstPre.deviationSd))
      ) {
        worstPre = f;
      }
    }
    if (worstPre) preOnset.push(worstPre);

    // 2) Nadir: worst deviation across the active span (onset → end).
    const active = episode.filter((p) => p.day >= window.onsetDay);
    let worstActive: VitalDeviationFinding | null = null;
    // The chronological index of the FIRST notably-deviated active day — the
    // anchor the recovery search must start AFTER (an early in-band run before
    // the vital ever deviated is not a "return", it is the run-up).
    let firstDeviationIndex = -1;
    // Whether THIS vital ever deviated adversely in the active span — gates it
    // out of the recovery-driver tally even if it shows a return.
    let vitalDeviatedAdversely = false;
    active.forEach((p, i) => {
      const f = finding(type, p.day, p.mean, center, spread);
      if (Math.abs(f.deviationSd) >= NOTABLE_SD) {
        if (firstDeviationIndex === -1) firstDeviationIndex = i;
        if (f.adverse) {
          adverseDayKeys.add(p.day);
          vitalDeviatedAdversely = true;
        }
        if (
          worstActive === null ||
          Math.abs(f.deviationSd) > Math.abs(worstActive.deviationSd)
        ) {
          worstActive = f;
        }
      }
    });
    if (worstActive) nadir.push(worstActive);

    // 3) Physiological return: only meaningful once the vital has actually
    //    deviated. Anchor the search AFTER the first notable deviation so an
    //    early in-band run can never be reported as a return BEFORE the
    //    deviation (which yielded a spurious negative gap). Excluded for
    //    CHRONIC_ONGOING (no recovered date by design).
    if (firstDeviationIndex >= 0 && window.lifecycle !== "CHRONIC_ONGOING") {
      const returnedDay = lastStableReturn(
        active,
        center,
        spread,
        firstDeviationIndex,
      );
      const gapDays =
        returnedDay && window.feltBetterDay
          ? dayDiff(window.feltBetterDay, returnedDay)
          : null;
      returns.push({
        type,
        returnedDay,
        gapDays,
        adverse: vitalDeviatedAdversely,
      });
    }
  }

  // Symptom-burden return track — the user's OWN logged daily-impact curve,
  // folded in as one more return against the KNOWN-CONSTANT baseline (healthy
  // = 0). No MAD band, no contamination guard, no min-baseline floor: the band
  // IS the constant 0, so it sidesteps every reliability caveat the passive
  // vitals carry. Always adverse by construction (a logged impact is illness-
  // relevant), so it contributes to `adverseCoverageDays` and the headline gap
  // even when the passive vitals are thin — the genuine illness-relevant
  // contributor the WEIGHT-only floor lacked. Logged-days-only stability:
  // sparse logging WITHHOLDS the return rather than fabricating an all-clear.
  const symptomReturn = computeSymptomReturn(input.symptomBurden ?? [], window);
  if (symptomReturn) {
    returns.push(symptomReturn.finding);
    for (const day of symptomReturn.adverseDays) adverseDayKeys.add(day);
  }

  // Red-flag escalation runs DECOUPLED from the banded loop: it scans the raw
  // episode days for SpO2 + temperature against ABSOLUTE clinical floors, so a
  // rock-steady (MAD=0) vital that drops the band filter still escalates — the
  // safety-critical output must fire for exactly the low-variance population it
  // matters for. The fever path additionally unions the day-log `feverC`
  // series so a user journaling fever with no thermometer is still seen.
  const redFlags = detectRedFlags(input);

  // Headline gap = median of the per-vital signed gaps (robust to one vital
  // recovering oddly). Null for CHRONIC_ONGOING / still active / no returns.
  const gaps = returns
    .map((r) => r.gapDays)
    .filter((g): g is number => g !== null);
  const recoveryGapDays =
    window.lifecycle === "CHRONIC_ONGOING" || gaps.length === 0
      ? null
      : Math.round(median(gaps)!);

  // Name the per-episode driver: among the ADVERSE return tracks that produced
  // a real gap, the one whose own gap sits closest to the headline median (it
  // is the return that "explains" the headline). The functional-impact symptom
  // track wins ties — it is the most illness-specific signal the engine has, so
  // when it co-explains the gap it gets to name it ("…before your symptoms
  // eased"). Null when no adverse return drove a gap.
  const gapDriverType =
    recoveryGapDays === null
      ? null
      : (returns
          .filter(
            (r): r is VitalReturnFinding & { gapDays: number } =>
              r.gapDays !== null && r.adverse,
          )
          .sort((a, b) => {
            const da = Math.abs(a.gapDays - recoveryGapDays);
            const db = Math.abs(b.gapDays - recoveryGapDays);
            if (da !== db) return da - db;
            // Tie: prefer the functional-impact symptom track, then by name.
            const fa = a.type === FUNCTIONAL_IMPACT_RETURN_KEY ? 0 : 1;
            const fb = b.type === FUNCTIONAL_IMPACT_RETURN_KEY ? 0 : 1;
            if (fa !== fb) return fa - fb;
            return String(a.type) < String(b.type) ? -1 : 1;
          })[0]?.type ?? null);

  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: banded.length,
    historyDays: coverageDays,
    missing: [],
    fullHistoryDays: Math.max(MIN_EPISODE_COVERAGE_DAYS, 14),
  });

  // Sleep-as-context — a neutral observation surfaced alongside the gap, NEVER a
  // return track and NEVER in the recovery-gap median. Withholds (null) on thin
  // data or a sub-floor delta.
  const sleepContext = computeSleepContext(
    input.baselineNights ?? [],
    input.episodeNights ?? [],
    window,
  );

  return buildOk<IllnessCorrelationValue>({
    value: {
      episodeId: input.episodeId,
      preOnset: preOnset.sort(
        (a, b) => Math.abs(b.deviationSd) - Math.abs(a.deviationSd),
      ),
      nadir: nadir.sort(
        (a, b) => Math.abs(b.deviationSd) - Math.abs(a.deviationSd),
      ),
      returns,
      recoveryGapDays,
      adverseCoverageDays: adverseDayKeys.size,
      feltBetterDay: window.feltBetterDay,
      gapDriverType: gapDriverType === null ? null : String(gapDriverType),
      redFlags,
      sleepContext,
    },
    coverage,
    confidence,
    provenance,
  });
}

/**
 * Start of the FINAL sustained in-band run in `active` (chronological) at/after
 * `fromIndex` — the day the vital *finally* settled and held. "In-band" =
 * |deviation| < NOTABLE_SD. Null when it never settles, when the final settle
 * is shorter than `RETURN_STABILITY_DAYS` observed days, or when a GENUINE
 * sustained re-deviation (≥ `RETURN_STABILITY_DAYS` out-of-band days) follows
 * the last settle with no re-settle (the vital is still elevated at the end).
 * `fromIndex` pins the search to AFTER the first deviation so an early in-band
 * run (the run-up to the illness) is never mistaken for a return.
 *
 * Relapse-aware AND noise-tolerant: an episode that settles, re-deviates (a
 * mid-episode flare), and settles again reports the LAST settle. A LONE
 * trailing out-of-band reading (or any tail shorter than the stability window)
 * after a real settle is transient measurement noise, NOT a relapse — it does
 * not null the return. Only a sustained out-of-band tail (≥ the stability
 * window) is read as a genuine unrecovered re-deviation and clears the return.
 * This keeps the change monotone for clean single-settle series (first == last,
 * unaffected) while not regressing a settle that happens to end on one noisy
 * out-of-band sample.
 */
function lastStableReturn(
  active: VitalDayPoint[],
  center: number,
  spread: number,
  fromIndex: number,
): string | null {
  const inBand = active.map((p) => ({
    day: p.day,
    in: Math.abs(deviationSd(p.mean, center, spread)) < NOTABLE_SD,
  }));
  if (inBand.length === 0) return null;

  // A sustained out-of-band TAIL (≥ stability window) means the vital genuinely
  // re-deviated after the last settle and never came back — still elevated, no
  // final return. A shorter trailing out-of-band tail is transient noise and is
  // ignored so a real settle that ends on a noisy sample is not lost.
  let tailOut = 0;
  while (tailOut < inBand.length && !inBand[inBand.length - 1 - tailOut].in) {
    tailOut++;
  }
  if (tailOut >= RETURN_STABILITY_DAYS) return null;

  // Walk back from the last IN-band reading to the start of its maximal run.
  // The run is CALENDAR-consecutive: extend only while the prior reading is both
  // in-band AND the calendar day immediately before this one. Points are
  // present-days-only (never zero-filled), so a sparse in-band series (e.g. days
  // 01/08/15) must NOT register as one long settle — that mirrors the `runFlag`
  // calendar-adjacency fix and bounds the run's span to its day count.
  const end = inBand.length - 1 - tailOut;
  let start = end;
  while (
    start - 1 >= 0 &&
    inBand[start - 1].in &&
    dayDiff(inBand[start - 1].day, inBand[start].day) === 1
  )
    start--;
  const run = end - start + 1;
  // The final settle must be long enough AND begin at/after the first deviation.
  if (run < RETURN_STABILITY_DAYS || start < Math.max(0, fromIndex))
    return null;
  return inBand[start].day;
}

/**
 * Compute the functional-impact (symptom-burden) return track for one episode.
 *
 * The symptom curve's baseline is the KNOWN CONSTANT 0 (healthy), so this needs
 * none of the passive vitals' MAD-band / contamination machinery — "adverse" is
 * simply `impact >= FUNCTIONAL_IMPACT_ADVERSE_FLOOR`, "in band" is below it.
 *
 *  - Only LOGGED days (present in `burden`) participate — never zero-filled.
 *  - The anchor is the first logged adverse day (same role as the vital
 *    `firstDeviationIndex`): a return search starts AFTER it, so a run-up is
 *    never read as a return.
 *  - A "return" is the START of the FINAL sustained in-band logged run at/after
 *    the anchor — the day symptoms *finally* eased and stayed eased, requiring
 *    `RETURN_STABILITY_DAYS` LOGGED days. Relapse-aware AND noise-tolerant
 *    (parity with the vital `lastStableReturn`): if symptoms ease, flare again,
 *    then ease again, the SECOND easing is the return; a trailing adverse tail
 *    SHORTER than the stability window is a single noisy late log and is
 *    tolerated, while a sustained adverse tail (≥ the window) is a genuine
 *    re-flare with no re-settle and WITHHOLDS the return. LOGGED-days stability
 *    (not calendar days) is the honest-withholding handler for sparse journals:
 *    a single trailing impact-0 log never satisfies the run on its own.
 *  - The gap is `dayDiff(feltBetterDay, returnedDay)`, same signed semantic.
 *  - Always `adverse:true` (a logged symptom curve is illness-relevant), so it
 *    feeds `adverseCoverageDays` and can drive the headline gap.
 *
 * Returns null (contributes nothing) when no adverse day was logged or the
 * episode is CHRONIC_ONGOING. `adverseDays` is the set of logged adverse days in
 * the active span, for the coverage tally.
 */
function computeSymptomReturn(
  burden: SymptomBurdenPoint[],
  window: EpisodeWindow,
): { finding: VitalReturnFinding; adverseDays: string[] } | null {
  if (window.lifecycle === "CHRONIC_ONGOING") return null;
  // Active span only, chronological. (Logged days are sparse and arbitrary, so
  // a stable sort by the day key is the canonical order.)
  const active = burden
    .filter((p) => p.day >= window.onsetDay)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  if (active.length === 0) return null;

  const adverseDays = active
    .filter((p) => p.impact >= FUNCTIONAL_IMPACT_ADVERSE_FLOOR)
    .map((p) => p.day);
  // No adverse day logged → there is nothing to "return" from.
  if (adverseDays.length === 0) return null;

  // Anchor: first logged adverse day. The return search starts there so an
  // early in-band log (impact 0 before symptoms appeared) is never a return.
  const firstAdverseIndex = active.findIndex(
    (p) => p.impact >= FUNCTIONAL_IMPACT_ADVERSE_FLOOR,
  );
  // Start of the FINAL sustained in-band logged run (relapse-aware "last
  // return"): walk back from the last logged day. Mirrors the vital
  // `lastStableReturn` — a trailing adverse tail SHORTER than the stability
  // window is tolerated (a single noisy late log does not null a real ease),
  // while a sustained adverse tail (≥ the window) is a genuine re-flare with no
  // re-settle → null (honest withholding).
  const inBand = active.map((p) => p.impact < FUNCTIONAL_IMPACT_ADVERSE_FLOOR);
  let returnedDay: string | null = null;
  if (inBand.length > 0) {
    let tailOut = 0;
    while (tailOut < inBand.length && !inBand[inBand.length - 1 - tailOut]) {
      tailOut++;
    }
    if (tailOut < RETURN_STABILITY_DAYS) {
      const end = inBand.length - 1 - tailOut;
      let start = end;
      // CALENDAR-consecutive run (parity with `lastStableReturn` / `runFlag`):
      // extend only while the prior LOGGED day is in-band AND the calendar day
      // immediately before this one. Sparse impact-0 logs (e.g. days 1/8/15)
      // must NOT stamp a "stable symptom return" across a multi-day span and
      // move the headline gap — the run's calendar span is bounded to its
      // logged-day count.
      while (
        start - 1 >= 0 &&
        inBand[start - 1] &&
        dayDiff(active[start - 1].day, active[start].day) === 1
      )
        start--;
      const run = end - start + 1;
      if (run >= RETURN_STABILITY_DAYS && start >= firstAdverseIndex) {
        returnedDay = active[start].day;
      }
    }
  }

  const gapDays =
    returnedDay && window.feltBetterDay
      ? dayDiff(window.feltBetterDay, returnedDay)
      : null;

  return {
    finding: {
      type: FUNCTIONAL_IMPACT_RETURN_KEY,
      returnedDay,
      gapDays,
      adverse: true,
    },
    adverseDays,
  };
}

/**
 * Compute the sleep-as-context observation: the user's MEDIAN asleep minutes
 * over the well baseline vs the MEAN over the episode's active span. A neutral
 * OBSERVATION only — never a recovery return, never folded into the gap median,
 * never a causal claim. Mirrors the engine's withholding ethos:
 *
 *   - Baseline needs ≥ `SLEEP_CONTEXT_MIN_BASELINE_NIGHTS` scorable nights AND
 *     the episode needs ≥ `SLEEP_CONTEXT_MIN_EPISODE_NIGHTS` (thin sleep data
 *     produces no observation — say nothing rather than guess).
 *   - The |delta| must reach `SLEEP_CONTEXT_MIN_DELTA_MINUTES` so day-to-day
 *     jitter is never narrated as a finding.
 *
 * Episode nights are clipped to the active span (`>= onsetDay`) so the
 * comparison reflects the illness, not the pre-onset lookback. Returns null
 * (says nothing) below either floor.
 */
function computeSleepContext(
  baselineNights: SleepNightPoint[],
  episodeNights: SleepNightPoint[],
  window: EpisodeWindow,
): SleepContext | null {
  const baseMinutes = baselineNights.map((n) => n.asleepMinutes);
  const episodeMinutes = episodeNights
    .filter((n) => n.day >= window.onsetDay)
    .map((n) => n.asleepMinutes);

  if (
    baseMinutes.length < SLEEP_CONTEXT_MIN_BASELINE_NIGHTS ||
    episodeMinutes.length < SLEEP_CONTEXT_MIN_EPISODE_NIGHTS
  ) {
    return null;
  }

  const baselineMeanMinutes = Math.round(median(baseMinutes)!);
  const episodeMeanMinutes = Math.round(
    episodeMinutes.reduce((s, v) => s + v, 0) / episodeMinutes.length,
  );
  const deltaMinutes = episodeMeanMinutes - baselineMeanMinutes;

  // Sub-floor delta is jitter, not a finding → say nothing.
  if (Math.abs(deltaMinutes) < SLEEP_CONTEXT_MIN_DELTA_MINUTES) return null;

  return {
    baselineMeanMinutes,
    episodeMeanMinutes,
    deltaMinutes,
    nightsCounted: episodeMinutes.length,
  };
}

/**
 * Detect the retrospective red flags — DECOUPLED from the banded loop and the
 * own-baseline band entirely. SpO2 and temperature escalate against ABSOLUTE
 * clinical floors over the RAW episode days (active span), so a rock-steady
 * (MAD=0) vital whose band was dropped still escalates. The fever path unions
 * the passive BODY_TEMPERATURE series (per-day max when available) with the
 * day-log `feverC` series so the canonical journaling-fever path is visible.
 * Conservative; escalation copy lives in the i18n layer.
 */
function detectRedFlags(input: IllnessCorrelationInput): IllnessRedFlag[] {
  const { window } = input;
  const flags: IllnessRedFlag[] = [];
  const inActive = (p: { day: string }) => p.day >= window.onsetDay;

  // SpO2 — sustained low. Mean series is the floor; use per-day-max only when
  // it would HELP (SpO2's worst is the min, so means are conservative enough).
  const spo2 = input.series.find((s) => s.type === "OXYGEN_SATURATION");
  if (spo2) {
    // `runFlag` counts CALENDAR-consecutive runs, so it needs chronological
    // input. Sort locally rather than trusting an upstream sort invariant — the
    // fever path already sorts its unioned series, and this keeps the SpO2 scan
    // order-independent by construction if a future reader feeds unsorted days.
    const spo2Points = spo2.episodeDays
      .filter(inActive)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const flag = runFlag(
      spo2Points,
      (v) => v <= SPO2_RED_FLAG,
      "sustained_low_spo2",
      "OXYGEN_SATURATION",
      "min",
    );
    if (flag) flags.push(flag);
  }

  // Fever — union the passive temperature series (per-day MAX preferred so an
  // evening spike is not masked by a daily mean) with the day-log feverC.
  const temp = input.series.find((s) => s.type === "BODY_TEMPERATURE");
  const tempPoints = temp
    ? (temp.episodeDayMax ?? temp.episodeDays).filter(inActive)
    : [];
  const feverByDay = new Map<string, number>();
  for (const p of tempPoints) {
    feverByDay.set(p.day, Math.max(feverByDay.get(p.day) ?? -Infinity, p.mean));
  }
  for (const p of input.dayLogFever ?? []) {
    if (!inActive(p)) continue;
    feverByDay.set(
      p.day,
      Math.max(feverByDay.get(p.day) ?? -Infinity, p.feverC),
    );
  }
  if (feverByDay.size > 0) {
    // `runFlag` counts CONSECUTIVE-day runs, so it needs chronological input.
    // The Map unions two individually-sorted sources (passive temperature, then
    // day-log feverC) in insertion order, NOT global day order — sort by day
    // before the run scan or an interleaved dual-source episode mis-counts the
    // run (a false sustained_fever escalation, or a real run hidden).
    const fevPoints: VitalDayPoint[] = [...feverByDay.entries()]
      .map(([day, mean]) => ({ day, mean }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const flag = runFlag(
      fevPoints,
      (v) => v >= FEVER_RED_FLAG,
      "sustained_fever",
      "BODY_TEMPERATURE",
      "max",
    );
    if (flag) flags.push(flag);
  }

  return flags;
}

/** Longest consecutive run matching `predicate`; flag when ≥ RED_FLAG_RUN_DAYS. */
function runFlag(
  sorted: VitalDayPoint[],
  predicate: (v: number) => boolean,
  reason: IllnessRedFlag["reason"],
  type: MeasurementType,
  worst: "min" | "max",
): IllnessRedFlag | null {
  let bestRun = 0;
  let bestWorst: number | null = null;
  let run = 0;
  let runWorst: number | null = null;
  let prevDay: string | null = null;
  for (const p of sorted) {
    if (predicate(p.mean)) {
      // A run is CALENDAR-consecutive days. Symptom/vital points are
      // present-days-only (never zero-filled), so a sparse febrile series
      // (e.g. days 01/10/15/20) must NOT count as one long run — that fires a
      // false sustained_fever escalation. Continue the run only when this
      // point is the calendar day immediately after the previous matching one;
      // otherwise the current point starts a fresh run of 1.
      const adjacent = prevDay !== null && dayDiff(prevDay, p.day) === 1;
      if (adjacent) {
        run++;
        runWorst =
          runWorst === null
            ? p.mean
            : worst === "min"
              ? Math.min(runWorst, p.mean)
              : Math.max(runWorst, p.mean);
      } else {
        run = 1;
        runWorst = p.mean;
      }
      if (run > bestRun) {
        bestRun = run;
        bestWorst = runWorst;
      }
      prevDay = p.day;
    } else {
      run = 0;
      runWorst = null;
      prevDay = null;
    }
  }
  if (bestRun >= RED_FLAG_RUN_DAYS && bestWorst !== null) {
    return { type, reason, worstValue: bestWorst, days: bestRun };
  }
  return null;
}

/** Whole-day signed difference `to − from` for two `YYYY-MM-DD` keys. */
export function dayDiff(from: string, to: string): number {
  return daysBetweenDateKeys(from, to);
}
