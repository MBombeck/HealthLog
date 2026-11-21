/**
 * v1.8.6 — ranked narrative takeaways for the mood surface.
 *
 * Plain-language, threshold-gated one-liners ("Your mood dips most on
 * Mondays") that turn the already-computed mood aggregates into the
 * "read this first" layer above the charts. Pure functions over the
 * existing aggregate shapes so the same takeaways feed BOTH
 * `/api/mood/insights` (the visible feed) and the LLM snapshot in
 * `mood-status.ts` — shown == sent, no prose/chart drift.
 *
 * The anti-platitude rule is enforced structurally: every minimum
 * sample / minimum effect bar is a NAMED CONSTANT, and a takeaway is
 * only emitted when its bar is cleared. Empty data → empty feed; no
 * "no correlation" filler.
 */

import { dayOffsetToDayKey } from "@/lib/insights/bucket-series";
import { round } from "@/lib/insights/status-shared";
import { MS_PER_DAY } from "@/lib/time-constants";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import type {
  StructuredTagRow,
  TagSummaryRow,
  TimeOfDayPattern,
  WeekdayRow,
} from "@/lib/insights/mood-aggregates";
import { mean } from "@/lib/stats/central";

// --- Named thresholds (the anti-platitude contract) ---

/** Minimum distinct daily points before any trend/weekend takeaway fires. */
export const MOOD_NARRATIVE_MIN_DAYS = 7;
/** Minimum score-point magnitude (1..5 scale) for an effect to count. */
export const MOOD_NARRATIVE_MIN_EFFECT = 0.3;
/** Minimum daily samples behind a weekday before its dip/peak is trusted. */
export const MOOD_NARRATIVE_MIN_WEEKDAY_SAMPLES = 3;
/** Minimum tagged occurrences before a tag→mood delta is surfaced. */
export const MOOD_NARRATIVE_MIN_TAG_COUNT = 3;
/** Days per slice when comparing the recent window against the prior one. */
export const MOOD_NARRATIVE_TREND_WINDOW = 7;
/** Minimum consecutive logged days before the streak takeaway congratulates. */
export const MOOD_NARRATIVE_MIN_STREAK = 3;
/** Maximum tag-delta takeaways surfaced (lift + drop combined are still capped). */
export const MOOD_NARRATIVE_MAX_TAG_ITEMS = 2;
/** Hard cap on the rendered feed length. */
export const MOOD_NARRATIVE_MAX_ITEMS = 8;

export type MoodNarrativeKind =
  | "weekday-dip"
  | "weekday-peak"
  | "trend"
  | "weekend"
  | "tag-lift"
  | "tag-drop"
  | "in-target"
  | "streak"
  | "time-of-day";

/**
 * A single takeaway. `messageKey` resolves to an i18n template; `vars`
 * are the interpolation values (strings so they survive JSON transport
 * to the client and the LLM snapshot unchanged). `strength` is the
 * ranking weight — higher sorts first — and is never rendered.
 */
export interface MoodNarrative {
  kind: MoodNarrativeKind;
  messageKey: string;
  vars: Record<string, string>;
  /** Ranking weight (effect size, normalised); higher = stronger. */
  strength: number;
}

type DailyPoint = { dayOffset: number; value: number };

export interface MoodNarrativeInput {
  daily: DailyPoint[];
  weekday: WeekdayRow[];
  /** v1.9.0 — tz-aware part-of-day pattern (gated on its own spread floor). */
  timeOfDay: TimeOfDayPattern;
  tags: TagSummaryRow[];
  structuredTags: StructuredTagRow[];
  inTargetPct: number | null;
  /** Day keys (YYYY-MM-DD) the user logged a mood on. */
  loggedDayKeys: string[];
  now: Date;
  /**
   * IANA timezone the streak anchor + day-walk are keyed in, so the "today"
   * key matches the tz-anchored `loggedDayKeys` for a logger east/west of
   * UTC near midnight. Defaults to `Europe/Berlin` when the caller has not
   * resolved the user's zone.
   */
  tz?: string;
}

/** i18n label keys for each part-of-day bucket. */
const TIME_OF_DAY_LABEL_KEYS = {
  morning: "insights.mood.timeOfDay.morning",
  afternoon: "insights.mood.timeOfDay.afternoon",
  evening: "insights.mood.timeOfDay.evening",
  night: "insights.mood.timeOfDay.night",
} as const;

const WEEKDAY_LABEL_KEYS = [
  "charts.weekdaysFull.mon",
  "charts.weekdaysFull.tue",
  "charts.weekdaysFull.wed",
  "charts.weekdaysFull.thu",
  "charts.weekdaysFull.fri",
  "charts.weekdaysFull.sat",
  "charts.weekdaysFull.sun",
] as const;

/** Weekday (0 = Monday … 6 = Sunday) for a daily-bucket offset. */
function weekdayOfOffset(
  now: Date,
  dayOffset: number,
  tz: string = DEFAULT_TIMEZONE,
): number {
  const dayKey = dayOffsetToDayKey(now, dayOffset, tz);
  const d = new Date(dayKey + "T00:00:00Z");
  return (d.getUTCDay() + 6) % 7;
}

// --- Individual takeaway builders ---

/**
 * Best / worst weekday vs the weekly mean. Fires the dip (worst day) and
 * the peak (best day) independently, each gated on the per-weekday sample
 * count and the effect magnitude against the overall weekday mean.
 */
function weekdayNarratives(input: MoodNarrativeInput): MoodNarrative[] {
  const populated = input.weekday.filter(
    (row): row is WeekdayRow & { avgScore: number } =>
      row.avgScore != null && row.count >= MOOD_NARRATIVE_MIN_WEEKDAY_SAMPLES,
  );
  if (populated.length < 2) return [];

  const overall = mean(populated.map((r) => r.avgScore));
  if (overall == null) return [];

  let best = populated[0];
  let worst = populated[0];
  for (const row of populated) {
    if (row.avgScore > best.avgScore) best = row;
    if (row.avgScore < worst.avgScore) worst = row;
  }

  const out: MoodNarrative[] = [];

  const dipDelta = round(overall - worst.avgScore, 2);
  if (dipDelta >= MOOD_NARRATIVE_MIN_EFFECT) {
    out.push({
      kind: "weekday-dip",
      messageKey: "insights.mood.narrative.weekdayDip",
      vars: {
        weekdayKey: WEEKDAY_LABEL_KEYS[worst.weekday],
        // eslint-disable-next-line healthlog/no-unlocalised-decimal -- wire value; the narrative feed parses it and prints it through useFormatters
        delta: dipDelta.toFixed(1),
      },
      strength: dipDelta,
    });
  }

  const peakDelta = round(best.avgScore - overall, 2);
  if (peakDelta >= MOOD_NARRATIVE_MIN_EFFECT) {
    out.push({
      kind: "weekday-peak",
      messageKey: "insights.mood.narrative.weekdayPeak",
      vars: {
        weekdayKey: WEEKDAY_LABEL_KEYS[best.weekday],
        // eslint-disable-next-line healthlog/no-unlocalised-decimal -- wire value; the narrative feed parses it and prints it through useFormatters
        value: best.avgScore.toFixed(1),
      },
      strength: peakDelta,
    });
  }

  return out;
}

/**
 * Trend direction: mean of the most recent window vs the prior window.
 * Both windows must carry the full sample count and their means must
 * differ by at least the effect threshold.
 */
function trendNarrative(input: MoodNarrativeInput): MoodNarrative | null {
  const w = MOOD_NARRATIVE_TREND_WINDOW;
  const recent = input.daily.filter((b) => b.dayOffset < w);
  const prior = input.daily.filter(
    (b) => b.dayOffset >= w && b.dayOffset < 2 * w,
  );
  if (recent.length < w || prior.length < w) return null;

  const recentMean = mean(recent.map((b) => b.value));
  const priorMean = mean(prior.map((b) => b.value));
  if (recentMean == null || priorMean == null) return null;

  const delta = round(recentMean - priorMean, 2);
  if (Math.abs(delta) < MOOD_NARRATIVE_MIN_EFFECT) return null;

  return {
    kind: "trend",
    messageKey:
      delta > 0
        ? "insights.mood.narrative.trendUp"
        : "insights.mood.narrative.trendDown",
    vars: {
      direction: delta > 0 ? "up" : "down",
      // eslint-disable-next-line healthlog/no-unlocalised-decimal -- wire value; the narrative feed parses it and prints it through useFormatters
      delta: Math.abs(delta).toFixed(1),
      days: String(w),
    },
    strength: Math.abs(delta),
  };
}

/**
 * Weekend vs weekday effect over the daily means. Both buckets must
 * carry data and the gap must clear the effect threshold.
 */
function weekendNarrative(input: MoodNarrativeInput): MoodNarrative | null {
  if (input.daily.length < MOOD_NARRATIVE_MIN_DAYS) return null;

  const weekend: number[] = [];
  const weekday: number[] = [];
  for (const bucket of input.daily) {
    const wd = weekdayOfOffset(
      input.now,
      bucket.dayOffset,
      input.tz ?? DEFAULT_TIMEZONE,
    );
    if (wd >= 5) weekend.push(bucket.value);
    else weekday.push(bucket.value);
  }
  const weekendMean = mean(weekend);
  const weekdayMean = mean(weekday);
  if (weekendMean == null || weekdayMean == null) return null;

  const delta = round(weekendMean - weekdayMean, 2);
  if (Math.abs(delta) < MOOD_NARRATIVE_MIN_EFFECT) return null;

  return {
    kind: "weekend",
    messageKey:
      delta > 0
        ? "insights.mood.narrative.weekendUp"
        : "insights.mood.narrative.weekendDown",
    vars: {
      direction: delta > 0 ? "up" : "down",
      // eslint-disable-next-line healthlog/no-unlocalised-decimal -- wire value; the narrative feed parses it and prints it through useFormatters
      delta: Math.abs(delta).toFixed(1),
    },
    strength: Math.abs(delta),
  };
}

/**
 * Top tag→mood deltas against the overall daily mean. Flat free-text tags
 * AND structured taxonomy tags share one ranked pool: the strongest lift
 * and the strongest drop across both axes survive (capped). Each candidate
 * needs the min occurrence count and an effect that clears the magnitude
 * threshold.
 *
 * The two axes carry different label shapes. A flat tag's label is the
 * raw free-text string, emitted as `vars.tag` and rendered verbatim. A
 * structured tag's label is an i18n message key from the catalog, emitted
 * as `vars.tagKey` so the renderer resolves it in the active locale
 * (mirroring the `weekdayKey` → `weekday` pattern) before interpolation.
 */
function tagNarratives(input: MoodNarrativeInput): MoodNarrative[] {
  const overall = mean(input.daily.map((b) => b.value));
  if (overall == null) return [];

  type Candidate = {
    /** Free-text label for flat tags; null for structured (use `labelKey`). */
    label: string | null;
    /** i18n key for structured tags; null for flat (use `label`). */
    labelKey: string | null;
    delta: number;
    count: number;
  };

  const candidates: Candidate[] = [];
  for (const row of input.tags) {
    if (row.count < MOOD_NARRATIVE_MIN_TAG_COUNT) continue;
    candidates.push({
      label: row.tag,
      labelKey: null,
      delta: round(row.avgScore - overall, 2),
      count: row.count,
    });
  }
  for (const row of input.structuredTags) {
    if (row.count < MOOD_NARRATIVE_MIN_TAG_COUNT) continue;
    // v1.16.11 — a custom tag carries its decrypted label (its labelKey
    // just mirrors the raw `custom:<uuid>` key, which `t()` cannot
    // resolve); it renders verbatim like a flat tag. Catalogue tags keep
    // the i18n labelKey path.
    const customLabel = row.label ?? null;
    candidates.push({
      label: customLabel,
      labelKey: customLabel != null ? null : row.labelKey,
      delta: round(row.avgScore - overall, 2),
      count: row.count,
    });
  }

  const lifts = candidates
    .filter((c) => c.delta >= MOOD_NARRATIVE_MIN_EFFECT)
    .sort((a, b) => b.delta - a.delta);
  const drops = candidates
    .filter((c) => c.delta <= -MOOD_NARRATIVE_MIN_EFFECT)
    .sort((a, b) => a.delta - b.delta);

  const tagVars = (c: Candidate): Record<string, string> =>
    c.labelKey != null ? { tagKey: c.labelKey } : { tag: c.label ?? "" };

  const out: MoodNarrative[] = [];
  const topLift = lifts[0];
  if (topLift) {
    out.push({
      kind: "tag-lift",
      messageKey: "insights.mood.narrative.tagLift",
      // eslint-disable-next-line healthlog/no-unlocalised-decimal -- wire value; the narrative feed parses it and prints it through useFormatters
      vars: { ...tagVars(topLift), delta: topLift.delta.toFixed(1) },
      strength: topLift.delta,
    });
  }
  const topDrop = drops[0];
  if (topDrop) {
    out.push({
      kind: "tag-drop",
      messageKey: "insights.mood.narrative.tagDrop",
      vars: {
        ...tagVars(topDrop),
        // eslint-disable-next-line healthlog/no-unlocalised-decimal -- wire value; the narrative feed parses it and prints it through useFormatters
        delta: Math.abs(topDrop.delta).toFixed(1),
      },
      strength: Math.abs(topDrop.delta),
    });
  }

  return out.slice(0, MOOD_NARRATIVE_MAX_TAG_ITEMS);
}

/**
 * In-target share takeaway. Surfaces the already-computed `inTargetPct`
 * (the share of recent days in the good-mood band) once any recent data
 * exists. Strength is fixed-low so the more specific signals outrank it.
 */
function inTargetNarrative(input: MoodNarrativeInput): MoodNarrative | null {
  if (input.inTargetPct == null) return null;
  return {
    kind: "in-target",
    messageKey: "insights.mood.narrative.inTarget",
    vars: { pct: String(Math.round(input.inTargetPct)) },
    strength: 0.2,
  };
}

/**
 * Current consecutive logging streak ending today (or the most recent
 * logged day). Fires only at or above the minimum run. Strength is
 * fixed-low — encouragement, not analysis.
 */
function streakNarrative(input: MoodNarrativeInput): MoodNarrative | null {
  if (input.loggedDayKeys.length === 0) return null;

  const tz = input.tz ?? DEFAULT_TIMEZONE;
  const keys = new Set(input.loggedDayKeys);
  // Anchor "today" in the user's timezone so the key matches the tz-anchored
  // `loggedDayKeys` for a late-evening logger east/west of UTC.
  const todayKey = userDayKey(input.now, tz);
  // Walk the cursor from a NOON-UTC anchor of the day key: ±12h covers every
  // IANA offset, so `new Date(cursor)` always re-derives the same calendar day
  // in the user's zone regardless of whether they are east or west of UTC.
  const noonMs = (key: string) => Date.parse(key + "T12:00:00Z");
  const todayMs = noonMs(todayKey);

  // Anchor the streak at today if logged, else the most recent logged day.
  let anchorMs = todayMs;
  if (!keys.has(todayKey)) {
    const sorted = [...keys].sort().reverse();
    anchorMs = noonMs(sorted[0]);
    // A streak that does not include today is stale — don't congratulate.
    if (anchorMs !== todayMs) return null;
  }

  let run = 0;
  let cursor = anchorMs;
  while (keys.has(userDayKey(new Date(cursor), tz))) {
    run += 1;
    cursor -= MS_PER_DAY;
  }

  if (run < MOOD_NARRATIVE_MIN_STREAK) return null;

  return {
    kind: "streak",
    messageKey: "insights.mood.narrative.streak",
    vars: { days: String(run) },
    strength: 0.15,
  };
}

/**
 * Time-of-day takeaway: the part of day the user feels best.
 *
 * Rides the `TimeOfDayPattern.reliable` flag — already the once-a-day-
 * logger guard (≥2 buckets with ≥3 entries each) — so this builder adds
 * only the effect-magnitude gate on top: the best bucket must clear
 * `MOOD_NARRATIVE_MIN_EFFECT` over the worst before it counts as a
 * pattern rather than noise.
 */
function timeOfDayNarrative(input: MoodNarrativeInput): MoodNarrative | null {
  const { reliable, best, worst, buckets } = input.timeOfDay;
  if (!reliable || best == null || worst == null) return null;

  const byBucket = new Map(buckets.map((row) => [row.bucket, row]));
  const bestRow = byBucket.get(best);
  const worstRow = byBucket.get(worst);
  if (bestRow?.avgScore == null || worstRow?.avgScore == null) return null;

  const delta = round(bestRow.avgScore - worstRow.avgScore, 2);
  if (delta < MOOD_NARRATIVE_MIN_EFFECT) return null;

  return {
    kind: "time-of-day",
    messageKey: "insights.mood.narrative.timeOfDay",
    vars: {
      bucketKey: TIME_OF_DAY_LABEL_KEYS[best],
      // eslint-disable-next-line healthlog/no-unlocalised-decimal -- wire value; the narrative feed parses it and prints it through useFormatters
      value: bestRow.avgScore.toFixed(1),
    },
    strength: delta,
  };
}

/**
 * Build the ranked, threshold-gated narrative feed. Pure over the
 * supplied aggregates; emits only takeaways whose named thresholds are
 * cleared, sorted strongest-first, capped at `MOOD_NARRATIVE_MAX_ITEMS`.
 */
export function computeMoodNarratives(
  input: MoodNarrativeInput,
): MoodNarrative[] {
  const all: MoodNarrative[] = [
    ...weekdayNarratives(input),
    ...tagNarratives(input),
  ];

  const trend = trendNarrative(input);
  if (trend) all.push(trend);

  const weekend = weekendNarrative(input);
  if (weekend) all.push(weekend);

  const timeOfDay = timeOfDayNarrative(input);
  if (timeOfDay) all.push(timeOfDay);

  const inTarget = inTargetNarrative(input);
  if (inTarget) all.push(inTarget);

  const streak = streakNarrative(input);
  if (streak) all.push(streak);

  return all
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MOOD_NARRATIVE_MAX_ITEMS);
}
