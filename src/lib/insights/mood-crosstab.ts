/**
 * Tag × health-metric and RATED-factor × health-metric crosstabs for
 * the mood surface: with-vs-without (or low-vs-high median-split) metric
 * deltas per structured tag / rated factor, Welch-tested and BH-FDR
 * corrected as one family per board, with same-day and D → D+1 pairing
 * modes.
 *
 * Extracted verbatim from `mood-aggregates.ts`, which re-exports this
 * module so every existing call site keeps importing from the hub.
 * Everything here is a pure function over already-fetched rows; the DB
 * read + orchestration stay in the hub's `fetchMoodAggregates`.
 */

import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { benjaminiHochberg as fdrAdjust } from "@/lib/insights/correlation-discovery";
import { welchTTest } from "@/lib/insights/correlations";
import { round } from "@/lib/insights/status-shared";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { MS_PER_DAY } from "@/lib/time-constants";
import { userDayKey, shiftDateKey } from "@/lib/tz/format";
import type {
  CrossMetricMeasurement,
  MoodAggregateEntry,
  RatedFactorScore,
  StructuredTagRef,
} from "@/lib/insights/mood-aggregates";
import {
  collapseToTaggedDays,
  influenceConfidence,
  type InfluenceConfidence,
} from "@/lib/insights/mood-tag-influence";
import type { MeasurementType } from "@/generated/prisma/enums";
import type { MeasurementSource } from "@/generated/prisma/client";
import { median } from "@/lib/stats/central";

// --- Tag × health-metric crosstab (v1.12.0) ------------------------------

/**
 * v1.12.0 — per-tag × health-metric crosstab.
 *
 * Daylio's "Activities & Mood" board answers "how does my mood differ on
 * days I tagged X?". This extends the same with-vs-without comparison to a
 * health METRIC: for each structured mood tag present on enough days, the
 * metric's mean on tag-present days vs tag-absent days, the delta, the
 * Welch two-sided p, and a confidence band — reusing the EXACT statistics
 * engine the F1 tag-influence board already runs (`welchTTest` +
 * `influenceConfidence` + the per-group day floors). FDR-corrected across
 * every tested (tag × metric) pair via the shared `benjaminiHochberg`
 * step-up so the surface stays honest as the matrix grows.
 *
 * Pairing modes:
 *  - "sameDay" — the metric on the SAME day the tag was logged. Used for
 *    activity (a workout/active tag × ACTIVE_ENERGY_BURNED) and sleep (a
 *    sleep tag × SLEEP_DURATION).
 *  - "nextDay" — the metric on the day AFTER the tag (D → D+1 lag join, the
 *    same lag the correlation-discovery engine uses). Used for an
 *    alcohol/food tag × the overnight-recovery channels — readiness
 *    (RECOVERY_SCORE), resting heart rate and heart-rate variability —
 *    where the plausible direction is "tonight's choice → tomorrow's
 *    recovery".
 *
 * Observational only — the UI renders the standing "association, not
 * cause" caption once. The metric value is shown in its display unit
 * (SLEEP_DURATION minutes → hours; energy kcal; recovery score 0..100).
 */
/** Default Benjamini-Hochberg target FDR for the crosstab family. */
export const CROSSTAB_FDR_Q = 0.1;

/**
 * Per-side day floors for the crosstab — kept in step with the influence
 * floors (`INFLUENCE_MIN_PRESENT_DAYS` / `INFLUENCE_MIN_ABSENT_DAYS`) so a tag
 * needs the same defensible present/absent support before a metric delta
 * surfaces. Declared independently so the crosstab surface owns its own floor.
 */
export const CROSSTAB_MIN_PRESENT_DAYS = 5;
export const CROSSTAB_MIN_ABSENT_DAYS = 5;

/** Max rows surfaced across the whole crosstab so the surface stays scannable. */
export const CROSSTAB_MAX_ROWS = 8;

type CrosstabMode = "sameDay" | "nextDay";

/**
 * The metric channels the crosstab pairs each tag against. The `display`
 * key drives unit formatting on the client; `mode` fixes the pairing lag.
 * Single-sourced so the fetch filter (`CROSSTAB_METRIC_TYPES`) and the
 * compute can never drift.
 */
export const CROSSTAB_METRICS: Record<
  string,
  {
    type: MeasurementType;
    mode: CrosstabMode;
    display: "hours" | "kcal" | "score" | "bpm" | "ms";
  }
> = {
  // A workout / active tag × same-day active energy.
  activeEnergy: {
    type: "ACTIVE_ENERGY_BURNED",
    mode: "sameDay",
    display: "kcal",
  },
  // A sleep tag × same-night sleep duration (stored minutes → hours on UI).
  sleepDuration: { type: "SLEEP_DURATION", mode: "sameDay", display: "hours" },
  // An alcohol / food tag × next-day recovery/readiness (D → D+1 lag).
  nextDayRecovery: {
    type: "RECOVERY_SCORE",
    mode: "nextDay",
    display: "score",
  },
  // The two overnight-recovery vitals, same D → D+1 lag as recovery. A
  // recovery score is a wearable composite that many accounts never record,
  // and resting heart rate / HRV are the channels that carry the same
  // "last night's body" signal on a plain phone or scale sync. The rated-factor
  // board (`FACTOR_CROSSTAB_METRICS`) already tests both at this lag; the tag
  // board did not, so a BINARY evening tag — alcohol, a late meal, a nightcap —
  // had no path to either vital. Same engine, same floors, same BH family.
  nextDayRestingHeartRate: {
    type: "RESTING_HEART_RATE",
    mode: "nextDay",
    display: "bpm",
  },
  nextDayHeartRateVariability: {
    type: "HEART_RATE_VARIABILITY",
    mode: "nextDay",
    display: "ms",
  },
} as const;

export type CrosstabMetricKey = keyof typeof CROSSTAB_METRICS;

/** Display units the tag crosstab emits — derived so the row can't drift. */
export type CrosstabMetricDisplay =
  (typeof CROSSTAB_METRICS)[CrosstabMetricKey]["display"];

/** Distinct measurement types the crosstab reads — single-sourced. */
export const CROSSTAB_METRIC_TYPES: MeasurementType[] = Array.from(
  new Set(Object.values(CROSSTAB_METRICS).map((m) => m.type)),
);

export interface TagMetricCrosstabRow {
  /** Stable structured-tag key. */
  tag: string;
  /** i18n label key for the tag (structured tags only — never flat). */
  labelKey: string;
  /** Decrypted custom-tag label; null for catalogue tags. */
  label?: string | null;
  /** Parent category key, for grouping/icon. */
  categoryKey: string;
  /** Lucide icon name, or null. */
  icon: string | null;
  /** Which metric channel this row compares against. */
  metricKey: CrosstabMetricKey;
  /** Display unit hint for the client formatter. */
  display: CrosstabMetricDisplay;
  /** Pairing mode used (echoed so the UI can caption "next-day"). */
  mode: CrosstabMode;
  /** Days the tag was present that had a paired metric value. */
  withDays: number;
  /** Days the tag was absent that had a paired metric value. */
  withoutDays: number;
  /** Mean metric on tag-present days (display unit). */
  withAvg: number;
  /** Mean metric on tag-absent days (display unit). */
  withoutAvg: number;
  /** withAvg − withoutAvg (display unit). */
  delta: number;
  /** Welch two-sided p-value for the difference of means. */
  pValue: number;
  /** Benjamini-Hochberg adjusted q-value across the tested family. */
  qValue: number;
  /** Discrete confidence band (p + min per-group day count). */
  confidence: InfluenceConfidence;
  patternId?: string;
  canonicalKey?: string;
  dismissed?: boolean;
}

const CROSSTAB_SUM_TYPES = new Set<string>([
  "ACTIVE_ENERGY_BURNED",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
]);

/**
 * Build a metric map keyed by the user's local day, the calendar mood
 * entries are dated on, with the right aggregation. Energy
 * and step totals are SUMMED per day (HealthKit `stats:` rows are already
 * one daily-total row, so the sum is the total either way); sleep duration
 * is SUMMED across per-stage rows to get the night total; everything else
 * (a once-daily score) is MEANED. Returns minutes/kcal/raw — the display
 * conversion happens at row-build time.
 *
 * Cross-source de-dup: before bucketing, the rows for this metric run
 * through the SAME canonical-source picker the analytics steps/sleep path
 * uses (`pickCanonicalSourceRows`, keyed by `metricKeyForType` + the
 * local day key). Without it, the moment two sources report the same day
 * (Fitbit + Apple steps, Fitbit + WHOOP sleep) the SUM channels would
 * double-count and bias the Welch delta. The picker collapses each day to
 * one source (and one device-type within it), so the sum reflects one
 * stream. MEAN channels (a once-daily score like recovery) gain the same
 * single-source guarantee for free. Rows without a `source` (the legacy
 * test fixtures, or a metric whose source isn't in the ladder) fall
 * through the picker's pass-through branch unchanged.
 */
export function metricDayMap(
  measurements: CrossMetricMeasurement[],
  type: string,
  userPriorityJson: unknown,
  /** The user's zone: days are the user's own calendar days. */
  timeZone: string,
): Map<string, number> {
  const dayKeyOf = (d: Date) => userDayKey(d, timeZone);
  const summed = CROSSTAB_SUM_TYPES.has(type);

  const typeRows = measurements.filter((m) => m.type === type);
  if (typeRows.length === 0) return new Map();

  // Resolve the canonical source per day. `metricKeyForType` maps the
  // crosstab's MeasurementType to its priority ladder; a metric with no
  // ladder (or rows without a source) keeps every row via the picker's
  // documented pass-through fallback, so behaviour is identical to the
  // pre-fix sum for single-source data.
  const metricKey = metricKeyForType(type as MeasurementType);
  const canonicalRows = metricKey
    ? pickCanonicalSourceRows(
        typeRows.map((m) => ({
          measuredAt: m.measuredAt,
          source: (m.source ?? "MANUAL") as MeasurementSource,
          deviceType: m.deviceType ?? null,
          type: type as MeasurementType,
          value: m.value,
          count: m.count,
        })),
        metricKey,
        userPriorityJson,
        dayKeyOf,
      ).canonicalRows
    : typeRows;

  const byDay = new Map<string, { sum: number; count: number }>();
  for (const m of canonicalRows) {
    const key = dayKeyOf(m.measuredAt);
    const cur = byDay.get(key) ?? { sum: 0, count: 0 };
    cur.sum += m.value;
    cur.count += m.count ?? 1;
    byDay.set(key, cur);
  }
  const out = new Map<string, number>();
  for (const [key, agg] of byDay) {
    out.set(key, summed ? agg.sum : agg.sum / agg.count);
  }
  return out;
}

/** Add `lagDays` to a YYYY-MM-DD day key (UTC-anchored, DST-immune). */
export function shiftDayKey(day: string, lagDays: number): string {
  return shiftDateKey(day, lagDays);
}

/** Convert a raw metric value to the row's display unit. */
function toDisplayUnit(value: number, display: CrosstabMetricDisplay): number {
  return display === "hours" ? value / 60 : value;
}

interface CrosstabCandidate {
  row: Omit<TagMetricCrosstabRow, "qValue">;
}

/**
 * Compute the tag × metric crosstab. Pure over already-fetched rows.
 *
 * For every structured tag and every configured metric channel, collapse
 * the window to one observation per tz-anchored day (the tag's daily
 * membership) joined to the metric's per-day value (same-day or D+1). The
 * tag-present and tag-absent metric samples feed `welchTTest`; rows that
 * clear both day floors are tested, FDR-corrected as one family, and the
 * survivors (p < 0.05 AND q ≤ `CROSSTAB_FDR_Q`) surface ranked by q then
 * |delta|.
 *
 * Structured tags only — flat free-text tags are excluded because the
 * crosstab needs a stable, localized label and a curated-catalog tag is
 * the right granularity for a metric comparison.
 */
export function computeTagMetricCrosstab(args: {
  entries: MoodAggregateEntry[];
  measurements: CrossMetricMeasurement[];
  now: Date;
  windowDays?: number;
  /**
   * The user's source-priority blob. Threaded into `metricDayMap` so the
   * per-day canonical-source pick honours the user's ladder. `null` (the
   * test default) resolves to the default ladders.
   */
  userPriorityJson?: unknown;
  /** The user's zone, the calendar the metric days are cut on. */
  timeZone: string;
}): TagMetricCrosstabRow[] {
  const { entries, measurements, now } = args;
  const windowDays = args.windowDays ?? 365;
  const userPriorityJson = args.userPriorityJson ?? null;

  const dayMap = collapseToTaggedDays(entries, now, windowDays);
  if (dayMap.size === 0) return [];

  // The set of structured tags seen in the window, with their meta.
  const structuredMeta = new Map<string, StructuredTagRef>();
  for (const day of dayMap.values()) {
    for (const [key, ref] of day.structuredTags) {
      if (!structuredMeta.has(key)) structuredMeta.set(key, ref);
    }
  }
  if (structuredMeta.size === 0) return [];

  const candidates: CrosstabCandidate[] = [];

  for (const [metricKey, cfg] of Object.entries(CROSSTAB_METRICS) as Array<
    [CrosstabMetricKey, (typeof CROSSTAB_METRICS)[CrosstabMetricKey]]
  >) {
    const metricByDay = metricDayMap(
      measurements,
      cfg.type,
      userPriorityJson,
      args.timeZone,
    );
    if (metricByDay.size === 0) continue;

    for (const [tagKey, ref] of structuredMeta) {
      const withVals: number[] = [];
      const withoutVals: number[] = [];
      for (const [dayKey, day] of dayMap) {
        const metricKeyDay =
          cfg.mode === "nextDay" ? shiftDayKey(dayKey, 1) : dayKey;
        const metricValue = metricByDay.get(metricKeyDay);
        if (metricValue == null || !Number.isFinite(metricValue)) continue;
        const display = toDisplayUnit(metricValue, cfg.display);
        if (day.structuredTags.has(tagKey)) withVals.push(display);
        else withoutVals.push(display);
      }

      if (
        withVals.length < CROSSTAB_MIN_PRESENT_DAYS ||
        withoutVals.length < CROSSTAB_MIN_ABSENT_DAYS
      ) {
        continue;
      }

      const welch = welchTTest(withVals, withoutVals);
      const withAvg = withVals.reduce((s, v) => s + v, 0) / withVals.length;
      const withoutAvg =
        withoutVals.reduce((s, v) => s + v, 0) / withoutVals.length;
      const delta = withAvg - withoutAvg;
      if (delta === 0) continue;

      const pValue = welch.status === "ok" ? welch.pValue : 1;
      const minGroupDays = Math.min(withVals.length, withoutVals.length);

      candidates.push({
        row: {
          tag: tagKey,
          labelKey: ref.labelKey,
          label: ref.label ?? null,
          categoryKey: ref.categoryKey,
          icon: ref.icon,
          metricKey,
          display: cfg.display,
          mode: cfg.mode,
          withDays: withVals.length,
          withoutDays: withoutVals.length,
          withAvg: round(withAvg, 2),
          withoutAvg: round(withoutAvg, 2),
          delta: round(delta, 2),
          pValue,
          confidence: influenceConfidence(pValue, minGroupDays),
        },
      });
    }
  }

  if (candidates.length === 0) return [];

  // FDR-correct across the whole tested family (every tag × metric pair) so
  // the multiple-comparison surface stays honest as the matrix grows. Reuses
  // the same Benjamini-Hochberg step-up the correlation-discovery engine runs.
  const qValues = fdrAdjust(candidates.map((c) => c.row.pValue));

  return candidates
    .map((c, i) => ({ ...c.row, qValue: Math.round(qValues[i] * 1000) / 1000 }))
    .filter((row) => row.pValue < 0.05 && row.qValue <= CROSSTAB_FDR_Q)
    .sort(
      (a, b) =>
        a.qValue - b.qValue ||
        Math.abs(b.delta) - Math.abs(a.delta) ||
        a.tag.localeCompare(b.tag),
    )
    .slice(0, CROSSTAB_MAX_ROWS);
}

// --- RATED factor × health-metric crosstab (low- vs high-factor days) ---

/**
 * v1.14.0 — the flagship cross-domain insight: "on days you rated <factor>
 * low, your <vital> ran X below baseline".
 *
 * A RATED mood factor (work / sleep-quality / stress …) is a CONTINUOUS
 * per-day score, unlike the BINARY structured tags `computeTagMetricCrosstab`
 * handles. To reuse the EXACT same Welch + FDR engine, this thresholds the
 * factor's daily mean into a binary membership — a day is "low" when its
 * factor mean sits BELOW the factor's own median over the window, "high" at
 * or above. The median split is robust + self-calibrating (always two
 * non-empty groups when the factor has spread), and invents no fixed cutoff.
 *
 * `inverse` is applied at the SERIES boundary (the factor's per-day mean is
 * flipped to `(scaleMin + scaleMax) - raw` for an inverse factor like
 * stress), so the median split — and therefore the "low day" label — always
 * means "a worse day for this factor", honestly, without per-call casing.
 *
 * Same honesty discipline as the tag crosstab: both sides need
 * `CROSSTAB_MIN_PRESENT_DAYS` / `CROSSTAB_MIN_ABSENT_DAYS` paired metric
 * days, the family is BH-FDR corrected as one (across every factor × metric
 * × direction pair), survivors clear p < 0.05 AND q ≤ `CROSSTAB_FDR_Q`, and
 * the surface is capped + ranked. Observational only — the card renders the
 * standing "association, not cause" caption.
 */

/**
 * The metric channels the factor crosstab pairs each RATED factor against.
 * Broader than the tag crosstab (which is activity-focused) because the
 * value of a RATED factor is its bridge from a SUBJECTIVE score to an
 * OBJECTIVE vital. `sameDay` for same-night/same-day metrics (sleep,
 * steps); `nextDay` (D → D+1) for overnight-recovery metrics (RHR / HRV),
 * matching the plausible "today's factor → tomorrow's body" direction.
 */
export const FACTOR_CROSSTAB_METRICS: Record<
  string,
  {
    type: MeasurementType;
    mode: CrosstabMode;
    display: "hours" | "score" | "steps" | "bpm" | "ms" | "kg" | "mmHg";
  }
> = {
  sleepDuration: { type: "SLEEP_DURATION", mode: "sameDay", display: "hours" },
  steps: { type: "ACTIVITY_STEPS", mode: "sameDay", display: "steps" },
  restingHeartRate: {
    type: "RESTING_HEART_RATE",
    mode: "nextDay",
    display: "bpm",
  },
  heartRateVariability: {
    type: "HEART_RATE_VARIABILITY",
    mode: "nextDay",
    display: "ms",
  },
  weight: { type: "WEIGHT", mode: "sameDay", display: "kg" },
  bloodPressureSystolic: {
    type: "BLOOD_PRESSURE_SYS",
    mode: "sameDay",
    display: "mmHg",
  },
} as const;

export type FactorCrosstabMetricKey = keyof typeof FACTOR_CROSSTAB_METRICS;

/** Distinct measurement types the factor crosstab reads — single-sourced. */
export const FACTOR_CROSSTAB_METRIC_TYPES: MeasurementType[] = Array.from(
  new Set(Object.values(FACTOR_CROSSTAB_METRICS).map((m) => m.type)),
);

export interface FactorMetricCrosstabRow {
  /** Stable RATED-factor key. */
  factor: string;
  /** i18n label key for the factor. */
  labelKey: string;
  /** Parent category key, for grouping/icon. */
  categoryKey: string;
  /** Lucide icon name, or null. */
  icon: string | null;
  /**
   * `true` when the factor is inverse-scaled (stress / conflict). The
   * UI flips the phrasing — "your worse <factor> days" — but the split
   * itself already runs on the flipped series, so a "low" row always
   * means a worse day regardless.
   */
  inverse: boolean;
  /** Which metric channel this row compares against. */
  metricKey: FactorCrosstabMetricKey;
  /** Display unit hint for the client formatter. */
  display: FactorMetricDisplay;
  /** Pairing mode used (echoed so the UI can caption "next-day"). */
  mode: CrosstabMode;
  /** Days the factor was rated LOW (below its median) with a paired metric. */
  lowDays: number;
  /** Days the factor was rated HIGH (at/above its median) with a paired metric. */
  highDays: number;
  /** Mean metric on low-factor days (display unit). */
  lowAvg: number;
  /** Mean metric on high-factor days (display unit). */
  highAvg: number;
  /** lowAvg − highAvg (display unit). Negative = vital runs lower on low days. */
  delta: number;
  /** Welch two-sided p-value for the difference of means. */
  pValue: number;
  /** Benjamini-Hochberg adjusted q-value across the tested family. */
  qValue: number;
  /** Discrete confidence band (p + min per-group day count). */
  confidence: InfluenceConfidence;
  patternId?: string;
  canonicalKey?: string;
  dismissed?: boolean;
}

type FactorMetricDisplay =
  (typeof FACTOR_CROSSTAB_METRICS)[FactorCrosstabMetricKey]["display"];

/** Convert a raw metric value to its factor-crosstab display unit. */
function toFactorDisplayUnit(
  value: number,
  display: FactorMetricDisplay,
): number {
  return display === "hours" ? value / 60 : value;
}

/** Reference data for one RATED factor's daily series + its meta. */
interface FactorDailySeries {
  ref: Pick<
    RatedFactorScore,
    "key" | "labelKey" | "categoryKey" | "icon" | "inverse"
  >;
  /** Day key → factor's daily-mean score, inverse-flipped if needed. */
  byDay: Map<string, number>;
}

/**
 * Build a per-factor daily-mean series, applying the `inverse` sign-flip
 * once. For each tz-anchored day, the mean of the factor's ratings across
 * the day's entries; an inverse factor's rating `r` maps to
 * `(scaleMin + scaleMax) - r` BEFORE averaging so "up" always reads as a
 * better day. Pure. Exported for the discovery-channel path (period
 * narrative) so the two consumers can never diverge on the flip.
 */
export function buildFactorDailySeries(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays: number,
): Map<string, FactorDailySeries> {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const acc = new Map<
    string,
    {
      ref: FactorDailySeries["ref"];
      byDay: Map<string, { sum: number; count: number }>;
    }
  >();
  for (const entry of entries) {
    if (entry.moodLoggedAt.getTime() < cutoff) continue;
    if (!entry.ratedFactors) continue;
    for (const f of entry.ratedFactors) {
      if (!Number.isFinite(f.rating)) continue;
      // The documented sign-flip: an inverse factor's rating is mirrored
      // across its scale midpoint so a higher series value always means a
      // better day. Done here, once, at the series boundary.
      const value = f.inverse ? f.scaleMin + f.scaleMax - f.rating : f.rating;
      const slot = acc.get(f.key) ?? {
        ref: {
          key: f.key,
          labelKey: f.labelKey,
          categoryKey: f.categoryKey,
          icon: f.icon,
          inverse: f.inverse,
        },
        byDay: new Map<string, { sum: number; count: number }>(),
      };
      const cur = slot.byDay.get(entry.date) ?? { sum: 0, count: 0 };
      cur.sum += value;
      cur.count += 1;
      slot.byDay.set(entry.date, cur);
      acc.set(f.key, slot);
    }
  }
  const out = new Map<string, FactorDailySeries>();
  for (const [key, slot] of acc) {
    const byDay = new Map<string, number>();
    for (const [day, agg] of slot.byDay) byDay.set(day, agg.sum / agg.count);
    out.set(key, { ref: slot.ref, byDay });
  }
  return out;
}

interface FactorCrosstabCandidate {
  row: Omit<FactorMetricCrosstabRow, "qValue">;
}

/**
 * Compute the RATED-factor × metric crosstab. Pure over already-fetched
 * rows. Mirrors `computeTagMetricCrosstab` but splits each factor's
 * continuous daily score into low/high by its own median, then runs the
 * same Welch + FDR engine.
 */
export function computeFactorMetricCrosstab(args: {
  entries: MoodAggregateEntry[];
  measurements: CrossMetricMeasurement[];
  now: Date;
  windowDays?: number;
  userPriorityJson?: unknown;
  /** The user's zone, the calendar the metric days are cut on. */
  timeZone: string;
}): FactorMetricCrosstabRow[] {
  const { entries, measurements, now } = args;
  const windowDays = args.windowDays ?? 365;
  const userPriorityJson = args.userPriorityJson ?? null;

  const factorSeries = buildFactorDailySeries(entries, now, windowDays);
  if (factorSeries.size === 0) return [];

  const candidates: FactorCrosstabCandidate[] = [];

  for (const [metricKey, cfg] of Object.entries(
    FACTOR_CROSSTAB_METRICS,
  ) as Array<
    [
      FactorCrosstabMetricKey,
      (typeof FACTOR_CROSSTAB_METRICS)[FactorCrosstabMetricKey],
    ]
  >) {
    const metricByDay = metricDayMap(
      measurements,
      cfg.type,
      userPriorityJson,
      args.timeZone,
    );
    if (metricByDay.size === 0) continue;

    for (const [factorKey, series] of factorSeries) {
      // The median split is over the factor's own rated days only, so a
      // sparse factor never borrows another's threshold.
      const ratedDays = [...series.byDay.values()];
      if (
        ratedDays.length <
        CROSSTAB_MIN_PRESENT_DAYS + CROSSTAB_MIN_ABSENT_DAYS
      ) {
        continue;
      }
      const split = median(ratedDays)!;

      const lowVals: number[] = [];
      const highVals: number[] = [];
      for (const [dayKey, score] of series.byDay) {
        const metricDayKey =
          cfg.mode === "nextDay" ? shiftDayKey(dayKey, 1) : dayKey;
        const metricValue = metricByDay.get(metricDayKey);
        if (metricValue == null || !Number.isFinite(metricValue)) continue;
        const display = toFactorDisplayUnit(metricValue, cfg.display);
        // Below the median is a "low" (worse, after the inverse flip) day;
        // at or above is "high". A perfectly bimodal factor with all days
        // exactly on the median falls entirely into "high" and fails the
        // low-side floor below — honest: no contrast, no row.
        if (score < split) lowVals.push(display);
        else highVals.push(display);
      }

      if (
        lowVals.length < CROSSTAB_MIN_PRESENT_DAYS ||
        highVals.length < CROSSTAB_MIN_ABSENT_DAYS
      ) {
        continue;
      }

      const welch = welchTTest(lowVals, highVals);
      const lowAvg = lowVals.reduce((s, v) => s + v, 0) / lowVals.length;
      const highAvg = highVals.reduce((s, v) => s + v, 0) / highVals.length;
      const delta = lowAvg - highAvg;
      if (delta === 0) continue;

      const pValue = welch.status === "ok" ? welch.pValue : 1;
      const minGroupDays = Math.min(lowVals.length, highVals.length);

      candidates.push({
        row: {
          factor: factorKey,
          labelKey: series.ref.labelKey,
          categoryKey: series.ref.categoryKey,
          icon: series.ref.icon,
          inverse: series.ref.inverse,
          metricKey,
          display: cfg.display,
          mode: cfg.mode,
          lowDays: lowVals.length,
          highDays: highVals.length,
          lowAvg: round(lowAvg, 2),
          highAvg: round(highAvg, 2),
          delta: round(delta, 2),
          pValue,
          confidence: influenceConfidence(pValue, minGroupDays),
        },
      });
    }
  }

  if (candidates.length === 0) return [];

  // One BH family across every factor × metric pair tested — the same
  // step-up the tag crosstab + discovery engine run.
  const qValues = fdrAdjust(candidates.map((c) => c.row.pValue));

  return candidates
    .map((c, i) => ({ ...c.row, qValue: Math.round(qValues[i] * 1000) / 1000 }))
    .filter((row) => row.pValue < 0.05 && row.qValue <= CROSSTAB_FDR_Q)
    .sort(
      (a, b) =>
        a.qValue - b.qValue ||
        Math.abs(b.delta) - Math.abs(a.delta) ||
        a.factor.localeCompare(b.factor),
    )
    .slice(0, CROSSTAB_MAX_ROWS);
}
