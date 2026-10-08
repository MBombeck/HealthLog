/**
 * v1.10.0 — transparent Sleep Score (catalogue metric #6, COMPOSITE).
 *
 * A 0–100 sleep-quality composite whose sub-scores are SHOWN, not a black
 * box. Built from the per-stage `SLEEP_DURATION` rows HealthKit + Withings
 * write (one row per stage per night, `value` in minutes, `sleepStage` ∈
 * { IN_BED, AWAKE, ASLEEP, REM, CORE, DEEP }). Combines:
 *
 *   - **Sufficiency** = total asleep minutes vs an age-based need target
 *     (Hirshkowitz et al. 2015 National Sleep Foundation recommendations).
 *   - **Efficiency**  = asleep ÷ in-bed minutes (AASM scoring convention;
 *     ≥ 85 % is the clinical "good" floor).
 *   - **Consistency** = SD of the sleep midpoint across the window (lower
 *     is better) — a regularity proxy.
 *   - **Composition** = REM% + Deep% of total asleep vs Ohayon et al. 2017
 *     age norms.
 *
 * Each sub-score is 0..100 with its own transparent weight; the composite
 * **reweights around missing sub-scores** exactly as `health-score.ts`
 * null-redistributes (a legacy `ASLEEP`-only night yields Sufficiency +
 * Efficiency + Consistency + Timing, dropping Composition gracefully — it
 * is never fabricated). Restfulness / Restoration are NOT derivable (no
 * per-stage HR, no WASO timestamps) and are omitted, not faked.
 *
 * Standard: AASM scoring conventions (efficiency); Hirshkowitz et al. 2015,
 * Sleep Health 1(1):40–43 (age-based duration need); Ohayon et al. 2017,
 * Sleep Health 3(1):6–19 (stage-percentage norms by age). Framing
 * discipline: consumer sleep-staging vs PSG is only moderately accurate —
 * the copy stays directional, never clinical.
 *
 * Server-only — reads raw `SLEEP_DURATION` rows via Prisma (per-stage rows
 * are not rolled up by stage, so the night reconstruction reads raw, but
 * bounded to the window). The pure scorers are exported for unit tests.
 */
import type {
  MeasurementSource,
  MeasurementType,
  SleepStage,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  reconstructSleepNights,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import type { BaselineProfile } from "./baseline";
import { SPARKLINE_MAX_POINTS, type Derived } from "./types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Default trailing window for the consistency/timing baseline (days). */
const DEFAULT_WINDOW_DAYS = 30;

/** Transparent sub-score weights (shown to the user, sum to 1 over present). */
export const SLEEP_SUBSCORE_WEIGHTS = {
  sufficiency: 0.3,
  efficiency: 0.25,
  consistency: 0.2,
  timing: 0.1,
  composition: 0.15,
} as const;

export type SleepSubScoreKey = keyof typeof SLEEP_SUBSCORE_WEIGHTS;

/** One sub-score row the anatomy view renders as a contributor. */
export interface SleepSubScore {
  key: SleepSubScoreKey;
  /** 0..100, or null when the night lacks the inputs (drops from the blend). */
  value: number | null;
  /** Effective weight after null-redistribution, 0..1. */
  weight: number;
}

export interface SleepScoreValue {
  /** The composite 0..100. */
  score: number;
  /** Band derived from the score (green/yellow/red). */
  band: "green" | "yellow" | "red";
  /** The night this score describes (YYYY-MM-DD of the wake day). */
  night: string;
  /** Total asleep minutes that night. */
  asleepMinutes: number;
  /** Total in-bed minutes that night (asleep + awake-in-bed), when known. */
  inBedMinutes: number | null;
  /** The transparent sub-scores (present + dropped). */
  subScores: SleepSubScore[];
  /** Nights in the window that backed the consistency/timing baseline. */
  windowNights: number;
  /**
   * v1.42 — the score of every scorable night in the window (oldest → newest,
   * capped to `SPARKLINE_MAX_POINTS`), so a surface can show the score's
   * course rather than one night. Each night is scored by the same blend as
   * the headline, against the same window's habitual midpoint, so the last
   * point IS `score`. Additive; older clients ignore it.
   */
  series: number[];
}

// ── pure scorers (exported for tests) ─────────────────────────────────

/**
 * Age-based sleep-need target in minutes (National Sleep Foundation,
 * Hirshkowitz et al. 2015). Adult default 7–9 h; we anchor the target at
 * the lower-recommended bound so hitting it scores 100.
 */
export function sleepNeedMinutes(ageYears: number | null): number {
  if (ageYears == null || !Number.isFinite(ageYears)) return 7 * 60; // adult default
  if (ageYears < 1) return 14 * 60;
  if (ageYears < 3) return 12 * 60;
  if (ageYears < 6) return 11 * 60;
  if (ageYears < 14) return 10 * 60;
  if (ageYears < 18) return 9 * 60;
  if (ageYears < 65) return 7 * 60;
  return 7 * 60; // 65+ NSF recommends 7–8 h
}

/** Sufficiency: asleep vs need, capped at 100 (oversleep is not penalised). */
export function scoreSufficiency(
  asleepMinutes: number,
  needMinutes: number,
): number | null {
  if (needMinutes <= 0) return null;
  return clamp100((asleepMinutes / needMinutes) * 100);
}

/**
 * Efficiency: asleep ÷ in-bed (AASM convention; ≥ 85 % is the clinical
 * "good" floor). Null when in-bed is unknown (legacy nights with only asleep
 * stages and no IN_BED row).
 *
 * Overlap handling: HealthKit can report ASLEEP-class stages whose summed
 * minutes exceed the explicit IN_BED total when stages overlap (the watch
 * writes per-sample stage rows and an IN_BED block that don't tile cleanly).
 * Treating that as a real ratio yields efficiency > 100 %, which a blind
 * `clamp(…, 100)` would silently swallow as a perfect night and hide the
 * data problem. Instead, treat asleep > in-bed as the impossible-overlap case
 * it is: cap efficiency at 100 % (asleep cannot exceed time in bed) but only
 * when the overshoot is within a small tolerance — a gross overshoot signals
 * a malformed night with no trustworthy in-bed denominator, so we drop the
 * sub-score (null) rather than report a fabricated 100.
 */
export function scoreEfficiency(
  asleepMinutes: number,
  inBedMinutes: number | null,
): number | null {
  if (inBedMinutes == null || inBedMinutes <= 0) return null;
  const pct = (asleepMinutes / inBedMinutes) * 100;
  if (pct > 100) {
    // A small overshoot (≤ 5 %) is rounding / stage-boundary noise — asleep
    // cannot truly exceed in-bed, so cap at the AASM ceiling of 100. A larger
    // overshoot means the in-bed total is not a usable denominator; the night
    // has no honest efficiency, so it drops from the blend.
    const EFFICIENCY_OVERSHOOT_TOLERANCE = 105;
    return pct <= EFFICIENCY_OVERSHOOT_TOLERANCE ? 100 : null;
  }
  return clamp100(pct);
}

/**
 * Composition: how close REM% + Deep% sit to the age-typical band
 * (Ohayon et al. 2017). Adults: REM ≈ 20–25 %, Deep ≈ 13–23 % of total
 * asleep. We score the combined REM+Deep fraction against a 33–48 % target
 * window — inside → 100, falling off linearly outside. Null when no stage
 * breakdown exists (a legacy `ASLEEP`-only night).
 */
export function scoreComposition(
  remMinutes: number,
  deepMinutes: number,
  asleepMinutes: number,
  hasStageBreakdown: boolean,
): number | null {
  if (!hasStageBreakdown || asleepMinutes <= 0) return null;
  const fraction = (remMinutes + deepMinutes) / asleepMinutes;
  const lo = 0.33;
  const hi = 0.48;
  if (fraction >= lo && fraction <= hi) return 100;
  // Linear fall-off: half a window-width away from the band → 0.
  const halfWidth = (hi - lo) / 2 + 0.15;
  const dist = fraction < lo ? lo - fraction : fraction - hi;
  return clamp100(100 * (1 - dist / halfWidth));
}

const MINUTES_PER_DAY = 1440;

/**
 * Shortest distance between two minutes-of-day on the 24-hour clock, treating
 * the day as circular (mod 1440). A midpoint at 23:50 (1430) and one at 00:10
 * (10) are 20 minutes apart, NOT 1420 — the linear difference inflates timing
 * SD and distance for sleepers whose midpoint straddles midnight (and on a DST
 * shift). Pure.
 */
export function circularMinuteDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % MINUTES_PER_DAY;
  return Math.min(raw, MINUTES_PER_DAY - raw);
}

/**
 * Circular mean of minutes-of-day via the mean resultant vector (the standard
 * directional-statistics circular mean) — averaging clock minutes linearly
 * collapses a midnight-straddling cluster to noon. Returns null on an empty
 * input or a near-zero resultant (no defined mean direction). Pure.
 */
export function circularMeanMinutes(minutes: number[]): number | null {
  if (minutes.length === 0) return null;
  let sumSin = 0;
  let sumCos = 0;
  for (const m of minutes) {
    const angle = (m / MINUTES_PER_DAY) * 2 * Math.PI;
    sumSin += Math.sin(angle);
    sumCos += Math.cos(angle);
  }
  if (Math.abs(sumSin) < 1e-9 && Math.abs(sumCos) < 1e-9) return null;
  let meanAngle = Math.atan2(sumSin, sumCos);
  if (meanAngle < 0) meanAngle += 2 * Math.PI;
  return (meanAngle / (2 * Math.PI)) * MINUTES_PER_DAY;
}

/**
 * Consistency: lower circular SD of the sleep midpoint (minutes-of-day)
 * across the window → higher score. A 90-min SD maps to 0, a 0-min SD to 100.
 * Null below 3 nights (no variance signal). The SD is computed against the
 * CIRCULAR mean using circular distance so a midnight-straddling sleeper is
 * not penalised for a spurious ~24-hour spread.
 */
export function scoreConsistency(midpointMinutes: number[]): number | null {
  if (midpointMinutes.length < 3) return null;
  const mean = circularMeanMinutes(midpointMinutes);
  if (mean == null) return null;
  const variance =
    midpointMinutes.reduce(
      (s, v) => s + circularMinuteDistance(v, mean) ** 2,
      0,
    ) / midpointMinutes.length;
  const sd = Math.sqrt(variance);
  const FULL_SCALE = 90; // minutes — beyond this the rhythm reads erratic.
  return clamp100(100 * (1 - Math.min(sd, FULL_SCALE) / FULL_SCALE));
}

/**
 * Timing: this night's midpoint vs the user's habitual midpoint (the window
 * circular mean). On-target → 100; 90 min off → 0. Null when the habitual
 * window is not yet established (< 3 nights). Uses circular distance so a
 * midnight-straddling night is measured by its true clock offset.
 */
export function scoreTiming(
  nightMidpoint: number | null,
  habitualMidpoint: number | null,
  windowNights: number,
): number | null {
  if (nightMidpoint == null || habitualMidpoint == null || windowNights < 3) {
    return null;
  }
  const FULL_SCALE = 90;
  const dist = circularMinuteDistance(nightMidpoint, habitualMidpoint);
  return clamp100(100 * (1 - Math.min(dist, FULL_SCALE) / FULL_SCALE));
}

function clamp100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

function bandForScore(score: number): "green" | "yellow" | "red" {
  if (score >= 70) return "green";
  if (score >= 40) return "yellow";
  return "red";
}

/**
 * Blend the present sub-scores with null-redistribution (the
 * `health-score.ts` pattern). Returns the composite + the per-sub-score
 * effective weights for the anatomy view. Pure.
 */
export function blendSleepSubScores(
  raw: Record<SleepSubScoreKey, number | null>,
): { score: number; subScores: SleepSubScore[] } {
  const keys = Object.keys(SLEEP_SUBSCORE_WEIGHTS) as SleepSubScoreKey[];
  const present = keys.filter((k) => raw[k] !== null);
  const totalBaseWeight = present.reduce(
    (s, k) => s + SLEEP_SUBSCORE_WEIGHTS[k],
    0,
  );
  const subScores: SleepSubScore[] = keys.map((k) => ({
    key: k,
    value: raw[k],
    weight:
      raw[k] === null || totalBaseWeight === 0
        ? 0
        : SLEEP_SUBSCORE_WEIGHTS[k] / totalBaseWeight,
  }));
  let composite = 0;
  for (const s of subScores) {
    if (s.value !== null) composite += s.value * s.weight;
  }
  return { score: clamp100(composite), subScores };
}

// ── night reconstruction ───────────────────────────────────────────────

interface SleepRow {
  value: number;
  measuredAt: Date;
  sleepStage: SleepStage | null;
  /**
   * Ingest source + device-type — fed to the canonical `reconstructSleepNights`
   * writer-dedup so a multi-source night (WHOOP + Apple Health) collapses to
   * ONE writer before summing instead of double-counting. Optional: a legacy
   * fixture or single-source caller that omits them dedups as before.
   */
  source?: MeasurementSource | null;
  deviceType?: string | null;
}

export interface NightSummary {
  /** Wake-day key (YYYY-MM-DD) the night is filed under. */
  night: string;
  asleepMinutes: number;
  awakeMinutes: number;
  remMinutes: number;
  deepMinutes: number;
  inBedMinutes: number | null;
  hasStageBreakdown: boolean;
  /** Midpoint as minutes-of-day (0..1439), or null when timestamps collapse. */
  midpoint: number | null;
}

/**
 * Adapt the canonical per-night reconstruction (`reconstructSleepNights`) into
 * the `NightSummary` shape the Sleep Score scorers consume. ONE ENGINE: the
 * same session-clustering, local-wake-day keying, and multi-source writer
 * dedup the dashboard / hypnogram / doctor surfaces use now also backs the
 * Sleep Score, so a multi-source night (WHOOP + Apple Health) is counted ONCE,
 * not summed across writers.
 *
 * This is an ADAPTER, not a drop-in: `reconstructSleepNights` returns the
 * canonical asleep total + per-stage map + in-bed/awake totals, and this
 * function derives the score-only fields the canonical engine does not carry —
 * `remMinutes` / `deepMinutes` from the stage map, `hasStageBreakdown` from the
 * presence of any granular stage, and `midpoint` from the asleep span (the
 * canonical night's wake instant minus half the asleep minutes), expressed in
 * the user's wall clock.
 *
 * `tz` is the IANA zone the midpoint is expressed against: a sleeper's
 * 03:00-local midpoint must read as minutes-of-day in THEIR wall clock, not
 * UTC, so a non-UTC user's consistency / timing sub-scores don't drift with
 * the offset. Defaults to UTC for back-compatible pure use. `priorityJson` is
 * the user's persisted source priority (or null for the defaults) so the
 * writer-dedup ladder matches every other sleep surface.
 */
export function reconstructNights(
  rows: SleepRow[],
  tz: string = "UTC",
  priorityJson: unknown = null,
): NightSummary[] {
  const stageRows: SleepStageRow[] = rows.map((r) => ({
    value: r.value,
    measuredAt: r.measuredAt,
    sleepStage: r.sleepStage,
    source: r.source ?? null,
    deviceType: r.deviceType ?? null,
  }));
  const nights = reconstructSleepNights(stageRows, tz, priorityJson);
  return nights.map((n) => {
    const rem = n.stages.REM ?? 0;
    const deep = n.stages.DEEP ?? 0;
    const core = n.stages.CORE ?? 0;
    const hasStageBreakdown = rem > 0 || deep > 0 || core > 0;
    const awakeMinutes = n.awakeMinutes ?? 0;
    // Efficiency denominator ("in bed"). The canonical engine sets
    // `inBedMinutes` to null unless a real IN_BED row exists anywhere in the
    // night — but a very common Apple-Health shape carries AWAKE rows and NO
    // IN_BED row, for which the legacy reconstructor synthesised a denominator
    // as `asleep + awake`. Taking the canonical null straight through silently
    // dropped the efficiency sub-score for that whole class of night, which
    // reweights the composite and shifts historical Sleep Scores. Restore the
    // synthesised fallback ON TOP of the (correctly deduped) canonical totals:
    // keep the real IN_BED figure when present, else synthesise `asleep + awake`
    // when both are positive, else keep null (neither signal — no honest
    // efficiency).
    const inBedMinutes =
      n.inBedMinutes != null
        ? n.inBedMinutes
        : n.asleepMinutes > 0 && awakeMinutes > 0
          ? n.asleepMinutes + awakeMinutes
          : null;
    // Midpoint = centre of the asleep span. The canonical night's `measuredAt`
    // is the wake instant (latest stage END); the asleep span is
    // `asleepMinutes` long ending there, so its centre is wake − asleep/2.
    const midpoint =
      n.asleepMinutes > 0
        ? minutesOfDay(
            new Date(n.measuredAt.getTime() - (n.asleepMinutes / 2) * 60_000),
            tz,
          )
        : null;
    return {
      night: n.night,
      asleepMinutes: n.asleepMinutes,
      awakeMinutes,
      remMinutes: rem,
      deepMinutes: deep,
      inBedMinutes,
      hasStageBreakdown,
      midpoint,
    };
  });
}

function minutesOfDay(d: Date, tz: string): number {
  if (tz === "UTC") return d.getUTCHours() * 60 + d.getUTCMinutes();
  const { hour, minute } = wallClockInTz(d, tz);
  return hour * 60 + minute;
}

// ── compute ─────────────────────────────────────────────────────────────

export interface SleepScoreOpts {
  windowDays?: number;
  now?: Date;
  /**
   * IANA zone the sleep midpoint is expressed against. Omit to resolve the
   * user's stored zone (the production path); pass explicitly in tests.
   */
  tz?: string;
}

/**
 * Compute the Sleep Score for the most recent night, using the trailing
 * window for the consistency/timing baseline. Returns `insufficient` when
 * no scorable night exists in the window.
 */
export async function computeSleepScore(
  userId: string,
  profile: BaselineProfile,
  opts: SleepScoreOpts = {},
): Promise<Derived<SleepScoreValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const computedAt = nowProvenanceTimestamp(now);
  // The midpoint is the user's wall-clock minutes-of-day, not UTC's, so a
  // non-UTC sleeper's consistency / timing sub-scores don't drift with the
  // offset. Resolve the stored zone unless a caller pins one.
  const tz = opts.tz ?? (await resolveUserTimezone(userId));
  // The canonical writer-dedup ladder needs the user's source priority — read
  // it alongside so a multi-source night collapses to the SAME writer the
  // dashboard / hypnogram pick.
  const priorityJson = await loadUserSourcePriority(userId);
  const inputs = ["SLEEP_DURATION"];
  const required = 1;
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);

  const rows = (await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION" satisfies MeasurementType,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    // `source` + `deviceType` feed the canonical writer-dedup so a multi-source
    // night is counted ONCE, not summed across writers.
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  })) as SleepRow[];

  if (rows.length === 0) {
    const { coverage } = deriveCoverage({
      requiredInputs: required,
      presentInputs: 0,
      historyDays: 0,
      missing: inputs,
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<SleepScoreValue>({
      coverage,
      provenance: { inputs, source: "none", windowDays, computedAt },
      reason: "no_sleep_in_window",
    });
  }

  // Reconstruct via the canonical engine (session-clustering, local-wake-day
  // keying, multi-source writer dedup) so the Sleep Score reads the SAME night
  // totals the dashboard / hypnogram / doctor surfaces do. Every reconstructed
  // night derives from ≥ 1 contributing row by construction, so a scorable
  // night is just one that carries asleep minutes.
  const scorableNights = reconstructNights(rows, tz, priorityJson).filter(
    (n) => n.asleepMinutes > 0,
  );

  if (scorableNights.length === 0) {
    const { coverage } = deriveCoverage({
      requiredInputs: required,
      presentInputs: 0,
      historyDays: 0,
      missing: inputs,
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<SleepScoreValue>({
      coverage,
      provenance: { inputs, source: "live", windowDays, computedAt },
      reason: "no_scorable_night",
    });
  }

  const latest = scorableNights[scorableNights.length - 1];
  const midpoints = scorableNights
    .map((n) => n.midpoint)
    .filter((m): m is number => m != null);
  // Circular mean (mod 1440) so a midnight-straddling sleeper's habitual
  // midpoint is not dragged to noon by a linear average.
  const habitualMidpoint = circularMeanMinutes(midpoints);

  const needMinutes = sleepNeedMinutes(profile.ageYears);

  const raw: Record<SleepSubScoreKey, number | null> = {
    sufficiency: scoreSufficiency(latest.asleepMinutes, needMinutes),
    efficiency: scoreEfficiency(latest.asleepMinutes, latest.inBedMinutes),
    consistency: scoreConsistency(midpoints),
    timing: scoreTiming(latest.midpoint, habitualMidpoint, midpoints.length),
    composition: scoreComposition(
      latest.remMinutes,
      latest.deepMinutes,
      latest.asleepMinutes,
      latest.hasStageBreakdown,
    ),
  };

  const { score, subScores } = blendSleepSubScores(raw);

  // The same blend over every scorable night in the window. Consistency is a
  // window-level figure and timing reads against the window's habitual
  // midpoint, so every night is judged by the yardstick the headline uses.
  const consistency = scoreConsistency(midpoints);
  const series = scorableNights.slice(-SPARKLINE_MAX_POINTS).map(
    (night) =>
      blendSleepSubScores({
        sufficiency: scoreSufficiency(night.asleepMinutes, needMinutes),
        efficiency: scoreEfficiency(night.asleepMinutes, night.inBedMinutes),
        consistency,
        timing: scoreTiming(night.midpoint, habitualMidpoint, midpoints.length),
        composition: scoreComposition(
          night.remMinutes,
          night.deepMinutes,
          night.asleepMinutes,
          night.hasStageBreakdown,
        ),
      }).score,
  );
  const presentCount = subScores.filter((s) => s.value !== null).length;
  const missing = subScores.filter((s) => s.value === null).map((s) => s.key);

  const { coverage, confidence } = deriveCoverage({
    // Coverage here is "sub-scores present / total possible" — the
    // composite's input axis is its five sub-scores, not the single
    // SLEEP_DURATION stream.
    requiredInputs: subScores.length,
    presentInputs: presentCount,
    historyDays: scorableNights.length,
    missing,
    fullHistoryDays: windowDays,
  });

  return buildOk<SleepScoreValue>({
    value: {
      score,
      band: bandForScore(score),
      night: latest.night,
      // Emit whole minutes (iOS #18) — the canonical totals sum second-
      // precision segments and can otherwise serialise as e.g. 433.4999.
      // Null-preserving on the in-bed signal.
      asleepMinutes: Math.round(latest.asleepMinutes),
      inBedMinutes:
        latest.inBedMinutes === null ? null : Math.round(latest.inBedMinutes),
      subScores,
      windowNights: scorableNights.length,
      series,
    },
    coverage,
    confidence,
    provenance: {
      inputs,
      source: "live",
      windowDays,
      computedAt,
    },
  });
}
