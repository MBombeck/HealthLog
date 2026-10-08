/**
 * v1.8.5 — shared mood-aggregate computation.
 *
 * Single source of truth for the analytics the mood surface needs.
 * `mood-status.ts` (the LLM snapshot builder) and `/api/mood/insights`
 * (the visualization endpoint) both consume these pure functions so the
 * numbers the user sees match the numbers the model reasons over — no
 * drift between the prose and the charts.
 *
 * Everything here is a pure function over already-fetched rows. The DB
 * read + orchestration lives in `fetchMoodAggregates` at the bottom;
 * the per-dimension helpers above it take plain arrays so they unit-test
 * without a database.
 *
 * v1.28.26 — the per-dimension calculators live in sibling modules
 * (`mood-tag-influence`, `mood-crosstab`, `mood-better-days`,
 * `mood-patterns`); this hub re-exports them all, so call sites keep
 * importing from here unchanged.
 */

import { prisma } from "@/lib/db";
import {
  significantPearsonCorrelation,
  type CorrelationResult,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import { MIN_PAIRED_N } from "@/lib/insights/correlations";
import {
  applyPayloadBudget,
  dayOffsetToDayKey,
  type DailyBucket,
} from "@/lib/insights/bucket-series";
import { round, summarizeSeries } from "@/lib/insights/status-shared";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import {
  computeMoodNarratives,
  type MoodNarrative,
} from "@/lib/insights/mood-narratives";
import {
  computeMoodDimensionSeries,
  type MoodDimensionSummary,
} from "@/lib/insights/mood-dimension-series";
export { type MoodDimensionSummary } from "@/lib/insights/mood-dimension-series";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { annotate } from "@/lib/logging/context";
import { createCustomLabelResolver } from "@/lib/mood/custom-tags";
import {
  computeContextMoodComparison,
  type ContextComparisonRow,
} from "@/lib/insights/mood-context-crosstab";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  computeBetterDays,
  type BetterDayFactor,
} from "@/lib/insights/mood-better-days";
import {
  computeFactorMetricCrosstab,
  computeTagMetricCrosstab,
  CROSSTAB_METRIC_TYPES,
  FACTOR_CROSSTAB_METRIC_TYPES,
  type FactorMetricCrosstabRow,
  type TagMetricCrosstabRow,
} from "@/lib/insights/mood-crosstab";
import {
  computeDistribution,
  computeInTargetPct,
  computeMoodStability,
  computeTimeOfDayAverages,
  computeWeekdayAverages,
  type DistributionRow,
  type MoodStability,
  type TimeOfDayPattern,
  type WeekdayRow,
} from "@/lib/insights/mood-patterns";
import {
  computeStructuredTagSummary,
  computeTagInfluence,
  computeTagSummary,
  type StructuredTagRow,
  type TagInfluence,
  type TagSummaryRow,
} from "@/lib/insights/mood-tag-influence";
import {
  decisionForEvidence,
  PATTERN_FAMILIES,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";
import type { MeasurementType } from "@/generated/prisma/enums";
import type { MeasurementSource } from "@/generated/prisma/client";

// Per-domain mood-analytics modules, re-exported so every existing call
// site keeps importing from this hub.
export * from "@/lib/insights/mood-better-days";
export * from "@/lib/insights/mood-crosstab";
export * from "@/lib/insights/mood-patterns";
export * from "@/lib/insights/mood-tag-influence";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Parse the flat `MoodEntry.tags` JSON string into a string array. The
 * column stores a JSON-encoded array (or null); the read path must
 * decode it before `computeTagSummary`'s `Array.isArray` check, otherwise
 * the flat-tag axis silently collapses to empty (the raw string is never
 * an array). Defensive against malformed JSON — returns `[]` on a parse
 * failure rather than throwing.
 */
function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Minimal daily-bucket shape the aggregates read. `DailyBucket` (from
 * `bucket-series`) carries an extra `n` field; the helpers only ever
 * touch `dayOffset` + `value`, so accepting the narrow shape keeps them
 * trivially testable without synthesising the unused field.
 */
export type DailyPoint = Pick<DailyBucket, "dayOffset" | "value">;

/**
 * A structured tag attached to a mood entry, resolved from the catalog
 * (`mood_tags` + its parent `mood_tag_categories`) via the
 * `mood_entry_tag_links` join. Carried alongside the legacy flat `tags`
 * string so the breakdown can surface both axes.
 */
export interface StructuredTagRef {
  /** Stable tag key (e.g. `happy`). */
  key: string;
  /** Parent category key (e.g. `feelings`). */
  categoryKey: string;
  /** i18n message key for the tag label. */
  labelKey: string;
  /**
   * v1.16.11 — decrypted free-text label for a per-user custom tag
   * (`custom:` key), resolved server-side. `null` / absent for catalogue
   * tags, whose `labelKey` resolves via i18n — a custom tag's `labelKey`
   * just mirrors its key, so without this field every insights surface
   * renders the raw `custom:<uuid>`. Renderers use `label ?? t(labelKey)`.
   */
  label?: string | null;
  /** Lucide icon name, or null. */
  icon: string | null;
}

/** Raw mood row shape the aggregates operate on. */
export interface MoodAggregateEntry {
  /** TZ-anchored day key (YYYY-MM-DD). */
  date: string;
  /** Numeric mood score 1..5. */
  score: number;
  /** JSON tag array, or null. */
  tags: unknown;
  /** Exact log timestamp — carries time-of-day. */
  moodLoggedAt: Date;
  /**
   * v1.9.0 — per-row IANA timezone the entry was logged under. Used to
   * bucket `moodLoggedAt` into a part of day in the user's own local
   * time. Optional: legacy rows (`tz IS NULL`) fall back to UTC, mirroring
   * the rollup-tier convention; the legacy aggregate tests keep their
   * narrow fixtures.
   */
  tz?: string | null;
  /**
   * v1.8.5 — structured tags from the taxonomy join. Additive next to
   * the flat `tags`: an entry can carry both. Optional so the legacy
   * aggregate tests (flat tags only) keep their narrow fixtures.
   */
  structuredTags?: StructuredTagRef[];
  /**
   * v1.38 — the day's context, when the entry carries one. Only the
   * categorical fields: the comparison below tests membership of a value, and
   * the numeric ratings are a different question this milestone does not ask.
   * Optional so every fixture written before contexts existed keeps its shape.
   */
  context?: {
    workStatus: string | null;
    contactCircles: string | null;
    contactForm: string | null;
    contactExtent: string | null;
    leisureCategories: string | null;
    eventType: string | null;
  } | null;
  /**
   * v1.37 — the five level-A values, each 0-10 and each nullable. Optional so
   * every fixture written before they existed keeps its narrow shape, and
   * nullable because an unanswered dimension is absent rather than average.
   */
  a1?: number | null;
  a2?: number | null;
  a3?: number | null;
  a4?: number | null;
  a5?: number | null;
  /**
   * v1.14.0 — per-entry RATED factor scores (work / sleep-quality /
   * stress …) from the same `mood_entry_tag_links` join, but carrying the
   * numeric `rating` instead of a present/absent flag. Optional so legacy
   * fixtures keep their narrow shape. A RATED factor is a *continuous*
   * daily signal, fed into the factor crosstab (low-vs-high-day vital
   * deviation) and the discovery matrix — distinct from BINARY structured
   * tags, which carry no `rating`.
   */
  ratedFactors?: RatedFactorScore[];
}

/**
 * A RATED mood factor's score on a single entry, resolved from the
 * catalog. Carries the scale + `inverse` flag so the analytics layer can
 * apply the documented sign-flip ("higher rating = worse day" → flip so
 * "up" always reads as better) once, at the series boundary.
 */
export interface RatedFactorScore {
  /** Stable factor key (e.g. `work`). */
  key: string;
  /** Parent category key. */
  categoryKey: string;
  /** i18n message key for the factor label. */
  labelKey: string;
  /** Lucide icon name, or null. */
  icon: string | null;
  /** The per-entry rating, bounded to `scaleMin..scaleMax` at ingest. */
  rating: number;
  /** Inclusive scale bounds (default 1..5). */
  scaleMin: number;
  scaleMax: number;
  /**
   * `true` when a higher rating means a WORSE day (stress / conflict).
   * The series builder flips an inverse factor's rating to
   * `(scaleMin + scaleMax) - rating` so "up" always reads as better.
   */
  inverse: boolean;
}

/**
 * Cross-metric row shape (WEIGHT / BLOOD_PRESSURE_SYS / PULSE / …).
 *
 * `source` / `deviceType` are optional so the correlation fixtures and
 * legacy single-source tests keep their narrow shape, but when present
 * they feed the crosstab's canonical-source pick: a cumulative metric
 * (steps / active energy / sleep) that two sources both report for the
 * same day must resolve to ONE source before summing, or the per-day
 * total double-counts (see `metricDayMap`). The picker keys off
 * `source` (the ladder axis) and `deviceType` (the watch>phone>scale
 * axis) exactly like the analytics steps/sleep path.
 */
export interface CrossMetricMeasurement {
  type: string;
  value: number;
  measuredAt: Date;
  source?: MeasurementSource | null;
  deviceType?: string | null;
  /**
   * Readings this row stands for. Absent on a raw reading (one). A row
   * pre-aggregated per day, source and device carries its readings' sum in
   * `value` and their number here, so the day's mean stays exact.
   */
  count?: number;
}

/**
 * v1.12.1 — cap on the cross-metric measurement read in
 * `fetchMoodAggregates`. Sized to keep a full data-rich 365-day window
 * intact rather than the old flat 5,000 which silently dropped the
 * oldest months (the read is `measuredAt desc`) once a multi-source,
 * high-frequency user (per-stage sleep + per-sample pulse/HRV across
 * Apple + Fitbit + WHOOP) blew past it. The crosstab/correlation only
 * need per-day values, but the read stays raw because the DAY rollup
 * buckets on UTC midnight while these aggregates key on the user's
 * Berlin calendar day — see the read comment. Exported so the read's
 * `take` and the truncation-annotation threshold share one constant.
 */
export const MOOD_CROSS_METRIC_ROW_CAP = 50_000;

// --- Target bands (mirror mood-chart VALUE_BANDS + mood-status) ---

/**
 * The mood-status generator grades "in target" as score >= 3.5. The
 * mood-chart paints three reference bands (1–2 red, 2–3 orange, 3–5
 * green). We keep both anchored here so the heatmap colour map and the
 * in-target headline never drift from the line chart.
 */
export const MOOD_GREEN_MIN = 3.5;
export const MOOD_GREEN_MAX = 5;
export const MOOD_ORANGE_MIN = 2;
export const MOOD_ORANGE_MAX = 3.5;

// --- Pair two daily-bucket series on dayOffset (lifted from mood-status) ---

/**
 * Pair two daily-bucket series on `dayOffset`. The synthesised `date`
 * field is anchored at the UTC midnight of the Berlin calendar day —
 * `dayOffsetToDayKey()` is the source of truth so DST boundaries
 * don't slip the day-key by one. Each pair also carries `dayKey`
 * directly so callers can label points without re-formatting.
 */
export function pairDailyBuckets(
  seriesA: DailyPoint[],
  seriesB: DailyPoint[],
  now: Date,
  tz: string = DEFAULT_TIMEZONE,
): Array<PairedPoint & { dayKey: string }> {
  const mapB = new Map(seriesB.map((entry) => [entry.dayOffset, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.dayOffset);
      if (b == null) return null;
      const dayKey = dayOffsetToDayKey(now, entry.dayOffset, tz);
      const [y, m, d] = dayKey.split("-").map(Number);
      return {
        a: entry.value,
        b,
        date: new Date(Date.UTC(y, m - 1, d)),
        dayKey,
      };
    })
    .filter(
      (entry): entry is PairedPoint & { dayKey: string } => entry !== null,
    );
}

// --- Heatmap (one cell per day, score band per cell) ---

export type HeatmapWindowDays = 30 | 90 | 365;

/**
 * The trailing windows the stability score is offered over. 365 is the
 * whole daily series the aggregate keeps, which is what `stability` has
 * always covered.
 */
export const MOOD_STABILITY_WINDOWS = [30, 90, 180, 365] as const;
export type MoodStabilityWindow = (typeof MOOD_STABILITY_WINDOWS)[number];

/**
 * Adaptive heatmap window so the grid is never mostly-empty.
 *
 * - < 90 days of history → 30-day window (a fresh logger sees a dense
 *   month, not a sparse year).
 * - 90..180 days → 90-day window.
 * - > 180 days → 365-day "year in pixels" (Daylio parity).
 *
 * `historyDays` is the span between the oldest and newest entry.
 */
export function selectHeatmapWindow(historyDays: number): HeatmapWindowDays {
  if (historyDays > 180) return 365;
  if (historyDays >= 90) return 90;
  return 30;
}

export interface HeatmapCell {
  /** YYYY-MM-DD day key. */
  date: string;
  /** Daily-mean mood score for the day. */
  score: number;
  /** Number of entries that fed the mean. */
  samples: number;
}

/**
 * Build the per-day heatmap cells from raw mood rows. One cell per day
 * key carrying the daily mean (multi-entry days averaged), restricted to
 * the adaptive window.
 */
export function computeHeatmapCells(
  entries: MoodAggregateEntry[],
  now: Date,
  windowDays: HeatmapWindowDays,
): HeatmapCell[] {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const entry of entries) {
    if (entry.moodLoggedAt.getTime() < cutoff) continue;
    const cur = byDay.get(entry.date) ?? { sum: 0, count: 0 };
    cur.sum += entry.score;
    cur.count += 1;
    byDay.set(entry.date, cur);
  }
  return Array.from(byDay.entries())
    .map(([date, stats]) => ({
      date,
      score: round(stats.sum / stats.count, 2),
      samples: stats.count,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- Cross-metric correlation (lifted from mood-status) ---

export interface CorrelationScatterPoint {
  x: number;
  y: number;
  /** Index signature so the point satisfies the chart's
   * `Record<string, number>` data constraint. */
  [key: string]: number;
}

/** Why a pairing produced no coefficient. */
export type MoodCorrelationSuppression = "insufficientPairs" | "notSignificant";

export interface MoodMetricCorrelation {
  result: CorrelationResult | null;
  /** Mood (x) vs metric (y) scatter points, paired by day. */
  points: CorrelationScatterPoint[];
  n: number;
  /**
   * Which bar the pairing fell short of, so the card can name it rather
   * than showing a blank that reads the same whether nothing was logged or
   * a full year of days simply did not line up. Absent when `result` is set.
   */
  suppressed?: MoodCorrelationSuppression;
}

/**
 * Pearson correlation between the mood daily series and one metric daily
 * series, paired on `dayOffset`. Returns the scatter points so the
 * caller can paint a `<ScatterCorrelationChart>` from the same pairing
 * the coefficient was computed over.
 *
 * This routes through `significantPearsonCorrelation` — n >= 20 AND
 * p < 0.05 — for the same reason the weight, blood-pressure and
 * mood-status surfaces do: the plain `pearsonCorrelation` bands from |r|
 * alone above a floor of five pairs, so five days of noise sloping the
 * right way arrive at the reader labelled "strong". A mood page is where
 * that costs the most, because the reader is looking for something to
 * change about their week.
 */
export function computeMoodMetricCorrelation(
  moodDaily: DailyPoint[],
  metricDaily: DailyPoint[],
  now: Date,
  tz: string = DEFAULT_TIMEZONE,
): MoodMetricCorrelation {
  const pairs = pairDailyBuckets(moodDaily, metricDaily, now, tz);
  const points = pairs.map((p) => ({ x: p.a, y: p.b }));
  const result = significantPearsonCorrelation(pairs);
  if (result) return { result, points, n: pairs.length };
  return {
    result: null,
    points,
    n: pairs.length,
    suppressed:
      pairs.length < MIN_PAIRED_N ? "insufficientPairs" : "notSignificant",
  };
}

// --- Orchestrated aggregate shape ---

/**
 * v1.8.5 — the cross-metric channels the mood page correlates against,
 * mapping the correlation key the UI reads to its measurement type. This
 * is the single source for both the `correlations` object below and the
 * `fetchMoodAggregates` measurement `in:[...]` filter, so the two can
 * never drift out of sync.
 */
export const CORRELATION_METRICS = {
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  pulse: "PULSE",
  weight: "WEIGHT",
  bloodPressureSystolic: "BLOOD_PRESSURE_SYS",
} as const;

export type CorrelationKey = keyof typeof CORRELATION_METRICS;

export interface MoodAggregates {
  summary: {
    points: number;
    mean: number | null;
    min: number | null;
    max: number | null;
    latest: number | null;
    /** latest daily mean minus the previous daily mean. */
    delta: number | null;
    inTargetPct: number | null;
    totalEntries: number;
    totalSpanDays: number;
    newestEntryDaysAgo: number | null;
  };
  heatmap: {
    windowDays: HeatmapWindowDays;
    cells: HeatmapCell[];
  };
  distribution: DistributionRow[];
  /**
   * v1.37 — one summary per level-A dimension: 7 / 30 / 90-day means, the
   * newest value with its age, and the daily series behind them. A dimension
   * nobody answered reports `present: false` and an empty series; the surface
   * says so rather than drawing a line through the middle of the scale.
   */
  dimensions: MoodDimensionSummary[];
  weekday: WeekdayRow[];
  /**
   * v1.9.0 — average mood per part of day, bucketed in each entry's own
   * timezone. `reliable` gates the chart + takeaway against the once-a-day
   * logger (everything in one bucket).
   */
  timeOfDay: TimeOfDayPattern;
  /**
   * v1.9.0 — day-to-day stability score (0..100, higher = steadier) plus a
   * descriptive band. `null` for a sparse logger (< STABILITY_MIN_DAYS).
   */
  stability: MoodStability | null;
  /**
   * The same score over the shorter trailing windows a client can pick
   * (`GET /api/mood/insights?days=N`). Cached with the rest of the aggregate
   * so a period switch costs nothing; the route serves the chosen one as
   * `stability` and does not publish this map.
   */
  stabilityByWindow: Record<MoodStabilityWindow, MoodStability | null>;
  tags: TagSummaryRow[];
  /**
   * v1.38 — how the day's pleasantness sat on days carrying each context
   * value against the days that did not. A comparison and never a cause: the
   * copy that renders it says so, and every row carries the two counts it was
   * computed from so a reader can weigh it themselves.
   */
  contextComparison: ContextComparisonRow[];
  /** v1.8.5 — structured-tag breakdown from the taxonomy join. */
  structuredTags: StructuredTagRow[];
  /**
   * v1.11.5 (F1) — tag "Influence on Mood": with-vs-without daily-mean
   * delta + Welch confidence band for each frequent flat / structured tag.
   */
  tagInfluence: TagInfluence;
  /**
   * v1.11.5 (F2) — unified "what's associated with your better days" board
   * folding the F1 tag deltas and the mood × health-metric correlations
   * into one effect-size-ranked, confidence-gated, observational list.
   */
  betterDays: BetterDayFactor[];
  /**
   * v1.12.0 — per-tag × health-metric crosstab: for each structured tag,
   * a health metric's mean on tag-present vs tag-absent days (same-day or
   * D→D+1 lag), Welch-tested + FDR-corrected. Observational; the card
   * renders the standing "association, not cause" caption.
   */
  tagMetricCrosstab: TagMetricCrosstabRow[];
  /**
   * v1.14.0 — per-RATED-factor × health-metric crosstab: for each factor
   * the user scores per entry (work / sleep-quality / stress …), a vital's
   * mean on the days the factor was rated LOW vs HIGH (median split, same-day
   * or D→D+1), Welch-tested + FDR-corrected. The cross-domain bridge from a
   * subjective score to an objective vital. Observational; the card renders
   * the standing "association, not cause" caption.
   */
  factorCrosstab: FactorMetricCrosstabRow[];
  /**
   * v1.8.6 — ranked, threshold-gated narrative takeaways. The "read
   * this first" layer above the charts; the same array feeds the LLM
   * snapshot so prose and feed never drift.
   */
  narratives: MoodNarrative[];
  correlations: Record<CorrelationKey, MoodMetricCorrelation>;
}

/**
 * Compute every mood aggregate from already-fetched rows. Pure — no DB
 * access — so callers (the endpoint and the unit tests) control the
 * fetch + the clock.
 */
export function computeMoodAggregates(args: {
  entries: MoodAggregateEntry[];
  measurements: CrossMetricMeasurement[];
  now: Date;
  /**
   * The user's source-priority blob, threaded into the crosstab's
   * per-day canonical-source pick. `null` (the test default) resolves to
   * the default ladders.
   */
  userPriorityJson?: unknown;
  /**
   * v1.2.5 (M-TZ3) — the user's IANA timezone. Threaded into every day
   * bucketing pass so a near-midnight reading lands on the user's own
   * calendar day. Defaults to Berlin for legacy / test callers.
   */
  tz?: string;
}): MoodAggregates {
  const { entries, measurements, now } = args;
  const userPriorityJson = args.userPriorityJson ?? null;
  const tz = args.tz ?? DEFAULT_TIMEZONE;

  const moodPoints = entries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodPoints, { now, tz });
  const moodDaily = moodSeries.daily;

  const moodSummary = summarizeSeries(
    moodDaily.map((bucket) => ({ value: bucket.value })),
  );

  // daily[0] = newest bucket (lowest dayOffset).
  const latest = moodDaily[0] ?? null;
  const previous = moodDaily[1] ?? null;

  const oldestEntry = entries.length > 0 ? entries[0].moodLoggedAt : null;
  const newestEntry =
    entries.length > 0 ? entries[entries.length - 1].moodLoggedAt : null;
  const totalSpanDays =
    oldestEntry && newestEntry
      ? Math.round((newestEntry.getTime() - oldestEntry.getTime()) / MS_PER_DAY)
      : 0;
  const newestEntryDaysAgo = newestEntry
    ? Math.round((now.getTime() - newestEntry.getTime()) / MS_PER_DAY)
    : null;

  const metricDaily = (type: string) =>
    applyPayloadBudget(
      measurements
        .filter((m) => m.type === type)
        .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
      { now, tz },
    ).daily;

  const windowDays = selectHeatmapWindow(totalSpanDays);

  const weekday = computeWeekdayAverages(moodDaily, now, tz);
  const timeOfDay = computeTimeOfDayAverages(entries);
  const stability = computeMoodStability(moodDaily);
  const stabilityByWindow = Object.fromEntries(
    MOOD_STABILITY_WINDOWS.map((days) => [
      days,
      days === 365
        ? stability
        : computeMoodStability(
            moodDaily.filter((bucket) => bucket.dayOffset < days),
          ),
    ]),
  ) as Record<MoodStabilityWindow, MoodStability | null>;
  const tags = computeTagSummary(entries, now);
  const structuredTags = computeStructuredTagSummary(entries, now);
  const tagInfluence = computeTagInfluence(entries, now);
  const inTargetPct = computeInTargetPct(moodDaily);

  const correlations = Object.fromEntries(
    Object.entries(CORRELATION_METRICS).map(([key, type]) => [
      key,
      computeMoodMetricCorrelation(moodDaily, metricDaily(type), now, tz),
    ]),
  ) as MoodAggregates["correlations"];

  const betterDays = computeBetterDays(tagInfluence, correlations);
  const tagMetricCrosstab = computeTagMetricCrosstab({
    entries,
    measurements,
    now,
    userPriorityJson,
    timeZone: tz,
  });
  const factorCrosstab = computeFactorMetricCrosstab({
    entries,
    measurements,
    now,
    userPriorityJson,
    timeZone: tz,
  });

  // v1.38 — every context value against the day's pleasantness, one BH-FDR
  // family across the whole sweep. Entries with no context contribute to the
  // "without" side of each comparison, which is what makes the counts mean
  // what the copy says they mean.
  const contextComparison = computeContextMoodComparison(
    entries.map((entry) => ({
      day: entry.date,
      moodA1: entry.a1 ?? null,
      workStatus: entry.context?.workStatus ?? null,
      contactCircles: entry.context?.contactCircles ?? null,
      contactForm: entry.context?.contactForm ?? null,
      contactExtent: entry.context?.contactExtent ?? null,
      leisureCategories: entry.context?.leisureCategories ?? null,
      eventType: entry.context?.eventType ?? null,
    })),
  );

  // Distinct day keys the user logged on — drives the streak takeaway.
  const loggedDayKeys = Array.from(new Set(entries.map((entry) => entry.date)));

  return {
    summary: {
      points: moodSummary?.points ?? 0,
      mean: moodSummary?.mean ?? null,
      min: moodSummary?.min ?? null,
      max: moodSummary?.max ?? null,
      latest: latest?.value ?? null,
      delta:
        latest && previous ? round(latest.value - previous.value, 2) : null,
      inTargetPct,
      totalEntries: entries.length,
      totalSpanDays,
      newestEntryDaysAgo,
    },
    heatmap: {
      windowDays,
      cells: computeHeatmapCells(entries, now, windowDays),
    },
    distribution: computeDistribution(moodDaily),
    dimensions: computeMoodDimensionSeries(
      entries.map((entry) => ({
        date: entry.date,
        a1: entry.a1 ?? null,
        a2: entry.a2 ?? null,
        a3: entry.a3 ?? null,
        a4: entry.a4 ?? null,
        a5: entry.a5 ?? null,
      })),
      dayOffsetToDayKey(now, 0, tz),
    ),
    weekday,
    timeOfDay,
    stability,
    stabilityByWindow,
    tags,
    structuredTags,
    tagInfluence,
    betterDays,
    tagMetricCrosstab,
    factorCrosstab,
    contextComparison,
    narratives: computeMoodNarratives({
      daily: moodDaily,
      weekday,
      timeOfDay,
      tags,
      structuredTags,
      inTargetPct,
      loggedDayKeys,
      now,
      tz,
    }),
    correlations,
  };
}

/**
 * DB read + orchestration for the mood-insights endpoint.
 *
 * Bounded reads mirror the mood-status path: 365 days of mood rows (the
 * heatmap window never exceeds a year) and 365 days × 5 cross-metric
 * channels. Tombstoned rows are excluded so the analytics match the
 * line chart.
 */
export async function fetchMoodAggregates(
  userId: string,
  now: Date = new Date(),
): Promise<MoodAggregates> {
  const windowCutoff = new Date(now.getTime() - 365 * MS_PER_DAY);

  const entries = await prisma.moodEntry
    .findMany({
      where: { userId, deletedAt: null, moodLoggedAt: { gte: windowCutoff } },
      orderBy: { moodLoggedAt: "desc" },
      take: 2000,
      select: {
        date: true,
        score: true,
        // v1.37 — the five level-A values. Plaintext columns, so the trend is
        // a plain read rather than a decrypt-per-row.
        moodA1: true,
        stressA2: true,
        energyA3: true,
        connectionA4: true,
        stabilityA5: true,
        tags: true,
        moodLoggedAt: true,
        // v1.9.0 — per-row IANA tz anchors the part-of-day bucketing in
        // the user's local time (legacy null rows fall back to UTC).
        tz: true,
        // v1.8.5 — pull the structured-tag links + their catalog rows so
        // the breakdown can fold structured tags next to the flat ones.
        // v1.14.0 — also pull the per-link `rating` + the factor's
        // kind/scale/inverse so RATED factors feed the factor crosstab.
        // v1.38 — the categorical context fields. The numeric ratings are not
        // read here: this surface compares membership of a value against the
        // day's pleasantness, and a rating is a different question.
        context: {
          select: {
            workStatus: true,
            contactCircles: true,
            contactForm: true,
            contactExtent: true,
            leisureCategories: true,
            eventType: true,
          },
        },
        tagLinks: {
          select: {
            rating: true,
            moodTag: {
              select: {
                key: true,
                labelKey: true,
                // v1.16.11 — owner + ciphertext so a custom tag's decrypted
                // label can ride beside its labelKey (which just mirrors the
                // raw `custom:<uuid>` key). Decrypted once per tag below.
                userId: true,
                labelEncrypted: true,
                icon: true,
                kind: true,
                scaleMin: true,
                scaleMax: true,
                inverse: true,
                category: { select: { key: true } },
              },
            },
          },
        },
      },
    })
    .then((rows) => {
      // Memoised per-tag decrypt — once per distinct custom tag, never per
      // entry link, so a 2000-row read costs at most one decrypt per tag.
      const resolveLabel = createCustomLabelResolver();
      return rows.reverse().map((row) => ({
        date: row.date,
        score: row.score,
        a1: row.moodA1,
        a2: row.stressA2,
        a3: row.energyA3,
        a4: row.connectionA4,
        a5: row.stabilityA5,
        tags: parseTags(row.tags),
        moodLoggedAt: row.moodLoggedAt,
        tz: row.tz,
        context: row.context,
        // BINARY links carry the structured-tag breakdown; RATED links
        // (a non-null `rating`) carry the factor score. One join, two axes.
        structuredTags: row.tagLinks
          .filter((link) => link.moodTag.kind !== "RATED")
          .map((link) => ({
            key: link.moodTag.key,
            categoryKey: link.moodTag.category.key,
            labelKey: link.moodTag.labelKey,
            label: resolveLabel(link.moodTag),
            icon: link.moodTag.icon,
          })),
        ratedFactors: row.tagLinks
          .filter(
            (link): link is typeof link & { rating: number } =>
              link.moodTag.kind === "RATED" && link.rating != null,
          )
          .map((link) => ({
            key: link.moodTag.key,
            categoryKey: link.moodTag.category.key,
            labelKey: link.moodTag.labelKey,
            icon: link.moodTag.icon,
            rating: link.rating,
            scaleMin: link.moodTag.scaleMin,
            scaleMax: link.moodTag.scaleMax,
            inverse: link.moodTag.inverse,
          })),
      }));
    });

  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        deletedAt: null,
        measuredAt: { gte: windowCutoff },
        // v1.8.5 — single-sourced from CORRELATION_METRICS so the fetched
        // channels and the computed correlations never drift apart.
        // v1.12.0 — union the crosstab metric channels so the tag × metric
        // board has its measurements without a second query.
        type: {
          in: Array.from(
            new Set<MeasurementType>([
              ...(Object.values(CORRELATION_METRICS) as MeasurementType[]),
              ...CROSSTAB_METRIC_TYPES,
              // v1.14.0 — union the factor-crosstab vital channels (RHR /
              // HRV / steps / sleep / weight / BP-sys) so the factor board
              // has its measurements without a second query.
              ...FACTOR_CROSSTAB_METRIC_TYPES,
            ]),
          ),
        },
      },
      orderBy: { measuredAt: "desc" },
      // v1.12.1 — scope the cap to the worst-case row count over the
      // 365-day window instead of the old flat 5,000. The crosstab +
      // correlation channels are per-day aggregates, but the read is raw
      // because the DAY rollup buckets on UTC midnight while the crosstab
      // / correlations key on the user's Berlin calendar day — feeding a
      // UTC-bucketed metric series against a Berlin-bucketed mood series
      // would skew the day pairing by up to a few hours at the boundary.
      // So we stay on raw rows but lift the cap above the realistic worst
      // case: SLEEP_DURATION (~6 stage rows/night) and PULSE / HRV ingest
      // the most rows/day, and a user syncing several sources multiplies
      // that — a flat 5,000 silently dropped the oldest months (the order
      // is `measuredAt desc`). The cap is the floor that keeps a full
      // data-rich year intact; if it is ever hit we annotate `truncated`
      // so the drop is observable rather than silently recency-biased.
      take: MOOD_CROSS_METRIC_ROW_CAP,
      select: {
        type: true,
        value: true,
        measuredAt: true,
        // v1.12.1 — source + deviceType drive the crosstab's canonical
        // per-day pick so a cumulative metric reported by two sources on
        // the same day (Fitbit + Apple steps, Fitbit + WHOOP sleep) is
        // summed once, not double-counted.
        source: true,
        deviceType: true,
      },
    })
    .then((rows) => rows.reverse());

  if (measurements.length >= MOOD_CROSS_METRIC_ROW_CAP) {
    // The read hit the cap — the oldest rows in the 365-day window were
    // dropped (order is `measuredAt desc`). Surface it on the wide event
    // so a silently-truncated, recency-biased crosstab/correlation is at
    // least observable instead of looking like clean data.
    annotate({
      action: { name: "mood.insights.cross_metric.truncated" },
      meta: { rows: measurements.length, cap: MOOD_CROSS_METRIC_ROW_CAP },
    });
  }

  const [userPriorityJson, tz] = await Promise.all([
    loadUserSourcePriority(userId),
    resolveUserTimezone(userId),
  ]);

  const aggregate = computeMoodAggregates({
    entries,
    measurements,
    now,
    userPriorityJson,
    tz,
  });

  const tagEvidence = aggregate.tagMetricCrosstab.map((row) => ({
    factorKey: `TAG:${row.tag}`,
    outcomeKey: `CROSSTAB:${row.metricKey}`,
    lagDays: row.mode === "nextDay" ? 1 : 0,
    sampleSize: row.withDays + row.withoutDays,
    effectSize: row.delta,
    pValue: row.pValue,
    qValue: row.qValue,
  }));
  const factorEvidence = aggregate.factorCrosstab.map((row) => ({
    factorKey: `RATED:${row.factor}`,
    outcomeKey: `CROSSTAB:${row.metricKey}`,
    lagDays: row.mode === "nextDay" ? 1 : 0,
    sampleSize: row.lowDays + row.highDays,
    effectSize: row.delta,
    pValue: row.pValue,
    qValue: row.qValue,
  }));
  const [tagDecisions, factorDecisions] = await Promise.all([
    syncAcceptedPatterns({
      userId,
      family: PATTERN_FAMILIES.moodTagCrosstab,
      accepted: tagEvidence,
      computedAt: now,
    }),
    syncAcceptedPatterns({
      userId,
      family: PATTERN_FAMILIES.moodFactorCrosstab,
      accepted: factorEvidence,
      computedAt: now,
    }),
  ]);

  return {
    ...aggregate,
    tagMetricCrosstab: aggregate.tagMetricCrosstab.map((row, index) => ({
      ...row,
      ...(decisionForEvidence(tagDecisions, tagEvidence[index]) ?? {}),
    })),
    factorCrosstab: aggregate.factorCrosstab.map((row, index) => ({
      ...row,
      ...(decisionForEvidence(factorDecisions, factorEvidence[index]) ?? {}),
    })),
  };
}
