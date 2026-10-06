/**
 * v1.18.7 — the present-focused "Signals of the day" block for the
 * daily briefing: per-metric today-vs-7d/30d deltas, an emerging slope,
 * and a recent anomaly, ranked by clinical priority with salient
 * signals bubbling first. Every numeric field is pre-computed so the
 * model states it rather than re-deriving the comparison.
 *
 * Extracted verbatim from `features.ts`, which re-exports this module
 * so every existing call site keeps importing from there.
 */
import { trendSlope } from "@/lib/analytics/trends";
import { avgInWindow, stdDev, toDataPoints } from "@/lib/insights/features";
import {
  SAME_HOURS_MIN_DAYS,
  SAME_HOURS_TYPES,
} from "@/lib/insights/derived/coincident-deviation";
import { dayKeyAgeInDays } from "@/lib/insights/measurement-freshness";
import type { MeasurementType } from "@/generated/prisma/client";
import { dayValue } from "@/lib/measurements/day-mean";
import { isPlausibleMetricValue } from "@/lib/measurements/value-domain";
import {
  roundToDisplay,
  vitalDisplayDecimals,
} from "@/lib/measurements/vital-precision";
import { userDayKey } from "@/lib/tz/format";
import { wallClockInTz } from "@/lib/tz/wall-clock";

/**
 * v1.18.7 — one present-focused signal feeding the daily briefing. Every
 * numeric field is pre-computed so the model states it rather than
 * re-deriving the comparison (which small LLMs do unreliably).
 */
export interface SignalOfDay {
  /** Briefing `sourceMetric` discriminator the UI pins an icon + route on. */
  metric:
    "bp" | "weight" | "pulse" | "mood" | "sleep" | "resting_hr" | "glucose";
  /** Natural-language label (no enum leak into prose). */
  label: string;
  /** Unit string when the metric carries one. */
  unit?: string;
  /**
   * Freshest reading (the "now" value the briefing leads with). Under
   * `basis: "sameHours"` it is today's mean so far.
   */
  latest: number;
  /**
   * Calendar days between the freshest reading and today in the reader's
   * zone. Always 0: a metric with no reading today yields no signal.
   */
  latestDaysAgo: number;
  /** Trailing-7d mean. */
  avg7: number | null;
  /** Trailing-30d mean. */
  avg30: number | null;
  /** Signed `latest − avg7`, pre-computed. */
  deltaVs7: number | null;
  /** Signed `latest − avg30`, pre-computed. */
  deltaVs30: number | null;
  /** Normal-swing SD over the trailing-30d window. */
  spread30: number | null;
  /** `|latest − avg30| > spread30` — the significance verdict as a boolean. */
  outsideNormalSwing: boolean;
  /** Emerging direction over the trailing 30 days (slope sign). */
  emergingTrend: "rising" | "falling" | "flat" | null;
  /** A peak / trough inside the last 14 days, when one stands out. */
  recentAnomaly: {
    kind: "peak" | "trough";
    value: number;
    anomalyDaysAgo: number;
  } | null;
  /**
   * `"sameHours"` for a type whose day mean moves with the hour (glucose,
   * `SAME_HOURS_TYPES`): today so far is compared with the same hours of the
   * earlier days, each cut at the local time of today's latest reading.
   * `latest` is then today's mean so far, `avg7` / `avg30` / `spread30` are
   * over those earlier days' same-hours means, and the anomaly is a day's
   * same-hours mean. Absent for the reading-against-window comparison.
   */
  basis?: "sameHours";
}

/** Compute historical comparison: current 7d avg vs previous 30d avg (days 7-37). */
export function computeHistoricalComparison(
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  day?: { type: string; tz: string },
): {
  current7dAvg: number | null;
  previous30dAvg: number | null;
  change: number | null;
} {
  const current7dAvg = avgInWindow(records, now, 7, 0, day);
  const previous30dAvg = avgInWindow(records, now, 37, 7, day);
  const change =
    current7dAvg !== null && previous30dAvg !== null
      ? Math.round((current7dAvg - previous30dAvg) * 100) / 100
      : null;
  return { current7dAvg, previous30dAvg, change };
}

/**
 * v1.18.7 — clinical priority order for the signals block. BP / glucose
 * lead, then resting HR / pulse, then weight, then mood.
 * Lower index = higher priority; the briefing surfaces the top ≤3.
 */
const SIGNAL_PRIORITY: SignalOfDay["metric"][] = [
  "bp",
  "glucose",
  "resting_hr",
  "pulse",
  "weight",
  "mood",
];

/** Round helper local to the signals builder. */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** How one signal is read: its zone, and the precision its figures carry. */
interface SignalRead {
  /** The reader's zone; "today" is the calendar day in it. */
  tz: string;
  /** The measurement type; picks the like-for-like path (`SAME_HOURS_TYPES`). */
  type: string;
  /** For pulse, the zone its day means are read in (`day-mean.ts`). */
  day?: { type: string; tz: string };
  /**
   * Display precision of a unit-insensitive metric (bpm, mmHg), applied
   * here. Weight and glucose stay canonical and are rounded where they are
   * converted into the reader's unit (`signalInReaderUnits`).
   */
  decimals?: number;
}

/**
 * Build one signal from a single metric's measurement records. Returns null
 * when the metric has no reading today, or fewer than three points in 30
 * days — a sparse metric cannot carry an honest "today vs your normal" read.
 *
 * "Today" is the calendar day in the reader's zone. Every signal is a
 * present-tense statement about the day ("pulse is up today"), so a reading
 * from yesterday morning read at nine in the evening is not one: it would
 * narrate a day on which nothing was measured. A metric that was not
 * measured today simply has no signal; the briefing's trend sections still
 * carry its history, dated.
 */
function buildSignal(
  metric: SignalOfDay["metric"],
  label: string,
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  unit: string | undefined,
  read: SignalRead,
): SignalOfDay | null {
  if (records.length === 0) return null;
  const newest = records[records.length - 1];
  const latestDaysAgo = dayKeyAgeInDays(
    userDayKey(newest.measuredAt, read.tz),
    userDayKey(new Date(now), read.tz),
  );
  if (latestDaysAgo !== 0) return null;
  if (SAME_HOURS_TYPES.has(read.type as MeasurementType)) {
    return buildSameHoursSignal(metric, label, records, now, unit, read);
  }
  const { day } = read;
  const shown = (v: number) =>
    read.decimals === undefined ? r2(v) : roundToDisplay(v, read.decimals);
  const shownOrNull = (v: number | null) => (v === null ? null : shown(v));

  const win30 = records.filter(
    (rec) => rec.measuredAt.getTime() >= now - 30 * 24 * 60 * 60 * 1000,
  );
  if (win30.length < 3) return null;

  // For pulse each window is the mean of its day values (`day-mean.ts`); the
  // spread and the anomaly stay over the readings.
  const avg7 = avgInWindow(records, now, 7, 0, day);
  const avg30 = avgInWindow(records, now, 30, 0, day);
  const spread30 = stdDev(win30.map((rec) => rec.value));
  const deltaVs7 = avg7 !== null ? shown(newest.value - avg7) : null;
  const deltaVs30 = avg30 !== null ? shown(newest.value - avg30) : null;
  const outsideNormalSwing =
    avg30 !== null && spread30 !== null && spread30 > 0
      ? Math.abs(newest.value - avg30) > spread30
      : false;

  const slope = trendSlope(toDataPoints(records), 30, now);
  const emergingTrend: SignalOfDay["emergingTrend"] = slope
    ? slope.direction === "up"
      ? "rising"
      : slope.direction === "down"
        ? "falling"
        : "flat"
    : null;

  // Recent anomaly: an extreme inside the last 14 days vs the 30d mean ± 2 SD.
  let recentAnomaly: SignalOfDay["recentAnomaly"] = null;
  // Track the RAW extreme magnitude — comparing against the already-r2()
  // rounded stored value can drop a genuinely larger anomaly.
  let bestAbs = 0;
  if (avg30 !== null && spread30 !== null && spread30 > 0) {
    const recent = records.filter(
      (rec) => rec.measuredAt.getTime() >= now - 14 * 24 * 60 * 60 * 1000,
    );
    for (const rec of recent) {
      const sd = (rec.value - avg30) / spread30;
      if (Math.abs(sd) >= 2) {
        const abs = Math.abs(rec.value - avg30);
        if (recentAnomaly === null || abs > bestAbs) {
          bestAbs = abs;
          recentAnomaly = {
            kind: (sd > 0 ? "peak" : "trough") as "peak" | "trough",
            value: shown(rec.value),
            anomalyDaysAgo: Math.round(
              (now - rec.measuredAt.getTime()) / (24 * 60 * 60 * 1000),
            ),
          };
        }
      }
    }
  }

  return {
    metric,
    label,
    ...(unit ? { unit } : {}),
    latest: shown(newest.value),
    latestDaysAgo,
    avg7: shownOrNull(avg7),
    avg30: shownOrNull(avg30),
    deltaVs7,
    deltaVs30,
    spread30: shownOrNull(spread30),
    outsideNormalSwing,
    emergingTrend,
    recentAnomaly,
  };
}

/** Seconds since local midnight of an instant in `tz`. */
function localSecondOfDay(at: Date, tz: string): number {
  const c = wallClockInTz(at, tz);
  return c.hour * 3600 + c.minute * 60 + c.second;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * The signal for a type whose day mean depends on how much of the day has
 * passed (`SAME_HOURS_TYPES`). A fasting glucose reading at seven held against
 * the mean of whole days (breakfast, lunch, dinner) reads as low every morning,
 * which is no statement about the day at all. So today so far is compared with
 * the same hours of the earlier days: every day is cut at the local clock time
 * of today's latest reading and reduced to its mean, then today's mean is held
 * against those day means. With fewer than `SAME_HOURS_MIN_DAYS` earlier days
 * in those hours there is nothing like-for-like to compare with, and no signal.
 * The same basis as the coincident-deviation flag and the metric page strip.
 */
function buildSameHoursSignal(
  metric: SignalOfDay["metric"],
  label: string,
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  unit: string | undefined,
  read: SignalRead,
): SignalOfDay | null {
  const { type } = read;
  const { tz } = read;
  const usable = records.filter((r) => isPlausibleMetricValue(type, r.value));
  if (usable.length === 0) return null;
  const newest = usable.reduce((a, b) =>
    b.measuredAt.getTime() > a.measuredAt.getTime() ? b : a,
  );
  const todayKey = userDayKey(new Date(now), tz);
  if (userDayKey(newest.measuredAt, tz) !== todayKey) return null;
  const cut = localSecondOfDay(newest.measuredAt, tz);
  const since = now - 30 * 24 * 60 * 60 * 1000;

  const byDay = new Map<string, Array<{ value: number; measuredAt: Date }>>();
  for (const r of usable) {
    const t = r.measuredAt.getTime();
    if (t < since || t > now) continue;
    if (localSecondOfDay(r.measuredAt, tz) > cut) continue;
    const key = userDayKey(r.measuredAt, tz);
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }
  const days: Array<{ key: string; age: number; value: number; at: Date }> = [];
  for (const [key, rows] of byDay) {
    const value = dayValue(type, rows, tz);
    const age = dayKeyAgeInDays(key, todayKey);
    if (value === null || age === null || age < 0) continue;
    const at = rows.reduce((a, b) => (b.measuredAt > a.measuredAt ? b : a));
    days.push({ key, age, value, at: at.measuredAt });
  }
  days.sort((a, b) => a.at.getTime() - b.at.getTime());
  const today = days.find((d) => d.age === 0);
  const earlier = days.filter((d) => d.age > 0);
  if (!today || earlier.length < SAME_HOURS_MIN_DAYS) return null;

  const shown = (v: number) =>
    read.decimals === undefined ? r2(v) : roundToDisplay(v, read.decimals);
  const shownOrNull = (v: number | null) => (v === null ? null : shown(v));

  const avg30 = mean(earlier.map((d) => d.value));
  const avg7 = mean(earlier.filter((d) => d.age <= 7).map((d) => d.value));
  const spread30 = stdDev(earlier.map((d) => d.value));
  const latest = today.value;
  const outsideNormalSwing =
    avg30 !== null && spread30 !== null && spread30 > 0
      ? Math.abs(latest - avg30) > spread30
      : false;

  const slope = trendSlope(
    days.map((d) => ({ date: d.at, value: d.value })),
    30,
    now,
  );
  const emergingTrend: SignalOfDay["emergingTrend"] = slope
    ? slope.direction === "up"
      ? "rising"
      : slope.direction === "down"
        ? "falling"
        : "flat"
    : null;

  let recentAnomaly: SignalOfDay["recentAnomaly"] = null;
  let bestAbs = 0;
  if (avg30 !== null && spread30 !== null && spread30 > 0) {
    for (const d of days) {
      if (d.age > 14) continue;
      const sd = (d.value - avg30) / spread30;
      const abs = Math.abs(d.value - avg30);
      if (Math.abs(sd) >= 2 && (recentAnomaly === null || abs > bestAbs)) {
        bestAbs = abs;
        recentAnomaly = {
          kind: sd > 0 ? "peak" : "trough",
          value: shown(d.value),
          anomalyDaysAgo: d.age,
        };
      }
    }
  }

  return {
    metric,
    label,
    ...(unit ? { unit } : {}),
    latest: shown(latest),
    latestDaysAgo: 0,
    avg7: shownOrNull(avg7),
    avg30: shownOrNull(avg30),
    deltaVs7: avg7 !== null ? shown(latest - avg7) : null,
    deltaVs30: avg30 !== null ? shown(latest - avg30) : null,
    spread30: shownOrNull(spread30),
    outsideNormalSwing,
    emergingTrend,
    recentAnomaly,
    basis: "sameHours",
  };
}

/**
 * v1.18.7 — assemble the present-focused "Signals of the day" block from the
 * in-memory measurement set (no extra DB round-trip). Computes today-vs-7d/30d
 * deltas, an emerging slope, and a recent anomaly per salient metric, then
 * returns the top ≤3 ranked by clinical priority. Salient signals
 * (outside-normal-swing or a recent anomaly) bubble above quiet ones inside
 * each priority tier so the briefing leads with what actually moved.
 */
export function computeSignalsOfDay(
  byType: (type: string) => Array<{ value: number; measuredAt: Date }>,
  now: number,
  /** The reader's zone: today's calendar day, and pulse's day means. */
  tz: string = "UTC",
): SignalOfDay[] {
  const candidates: SignalOfDay[] = [];
  const push = (s: SignalOfDay | null) => {
    if (s) candidates.push(s);
  };
  // Every read names its type, so a type joining `SAME_HOURS_TYPES` takes the
  // like-for-like path here without a second list to keep in step.
  const whole = (type: string) => ({
    tz,
    type,
    decimals: vitalDisplayDecimals(type, 0),
  });

  // Systolic carries the BP signal (the headline number clinicians read first).
  push(
    buildSignal(
      "bp",
      "blood pressure (systolic)",
      byType("BLOOD_PRESSURE_SYS"),
      now,
      "mmHg",
      whole("BLOOD_PRESSURE_SYS"),
    ),
  );
  // Absent data simply produces no signal.
  push(
    buildSignal(
      "glucose",
      "blood glucose",
      byType("BLOOD_GLUCOSE"),
      now,
      undefined,
      // Compared with the same hours of the earlier days, never with whole
      // days (see `buildSameHoursSignal`).
      { tz, type: "BLOOD_GLUCOSE" },
    ),
  );
  push(
    buildSignal(
      "resting_hr",
      "resting heart rate",
      byType("RESTING_HEART_RATE"),
      now,
      "bpm",
      whole("RESTING_HEART_RATE"),
    ),
  );
  push(
    buildSignal("pulse", "pulse", byType("PULSE"), now, "bpm", {
      ...whole("PULSE"),
      day: { type: "PULSE", tz },
    }),
  );
  // Weight and glucose are canonical here and carry no unit: the reader's
  // unit is attached where the signal is converted for the prompt
  // (`featuresInReaderUnits`), so no canonical symbol can leak into one.
  push(
    buildSignal("weight", "weight", byType("WEIGHT"), now, undefined, {
      tz,
      type: "WEIGHT",
    }),
  );
  // Sleep is stored one row per stage per night, so a raw "latest" point
  // would mis-sum; the sleep aggregates carry that signal already. Steps
  // ingest as many intraday `stats:`-prefixed samples, so the newest raw row
  // is a partial-day fragment, not a daily total — excluded like sleep.

  const priorityIndex = (m: SignalOfDay["metric"]) => {
    const idx = SIGNAL_PRIORITY.indexOf(m);
    return idx === -1 ? SIGNAL_PRIORITY.length : idx;
  };
  const salience = (s: SignalOfDay) =>
    (s.outsideNormalSwing ? 2 : 0) + (s.recentAnomaly ? 1 : 0);

  return candidates
    .sort((a, b) => {
      const sal = salience(b) - salience(a);
      if (sal !== 0) return sal;
      return priorityIndex(a.metric) - priorityIndex(b.metric);
    })
    .slice(0, 3);
}
