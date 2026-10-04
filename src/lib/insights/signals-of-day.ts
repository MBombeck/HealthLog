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
  /** Freshest reading (the "now" value the briefing leads with). */
  latest: number;
  /** Days since the freshest reading. */
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

/**
 * Build one signal from a single metric's measurement records. Returns null
 * when there is no fresh reading or fewer than three points in 30 days — a
 * sparse metric cannot carry an honest "today vs your normal" read.
 */
function buildSignal(
  metric: SignalOfDay["metric"],
  label: string,
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  unit?: string,
  day?: { type: string; tz: string },
): SignalOfDay | null {
  if (records.length === 0) return null;
  const newest = records[records.length - 1];
  const latestDaysAgo = Math.round(
    (now - newest.measuredAt.getTime()) / (24 * 60 * 60 * 1000),
  );
  // A reading older than two weeks is not a "signal of the day".
  if (latestDaysAgo > 14) return null;

  const win30 = records.filter(
    (rec) => rec.measuredAt.getTime() >= now - 30 * 24 * 60 * 60 * 1000,
  );
  if (win30.length < 3) return null;

  // For pulse each window is the mean of its day values (`day-mean.ts`); the
  // spread and the anomaly stay over the readings.
  const avg7 = avgInWindow(records, now, 7, 0, day);
  const avg30 = avgInWindow(records, now, 30, 0, day);
  const spread30 = stdDev(win30.map((rec) => rec.value));
  const deltaVs7 = avg7 !== null ? r2(newest.value - avg7) : null;
  const deltaVs30 = avg30 !== null ? r2(newest.value - avg30) : null;
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
            value: r2(rec.value),
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
    latest: r2(newest.value),
    latestDaysAgo,
    avg7,
    avg30,
    deltaVs7,
    deltaVs30,
    spread30,
    outsideNormalSwing,
    emergingTrend,
    recentAnomaly,
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
  /** The zone pulse days are read in (`day-mean.ts`). */
  pulseTz: string = "UTC",
): SignalOfDay[] {
  const candidates: SignalOfDay[] = [];
  const push = (s: SignalOfDay | null) => {
    if (s) candidates.push(s);
  };

  // Systolic carries the BP signal (the headline number clinicians read first).
  push(
    buildSignal(
      "bp",
      "blood pressure (systolic)",
      byType("BLOOD_PRESSURE_SYS"),
      now,
      "mmHg",
    ),
  );
  // Absent data simply produces no signal.
  push(buildSignal("glucose", "blood glucose", byType("BLOOD_GLUCOSE"), now));
  push(
    buildSignal(
      "resting_hr",
      "resting heart rate",
      byType("RESTING_HEART_RATE"),
      now,
      "bpm",
    ),
  );
  push(
    buildSignal("pulse", "pulse", byType("PULSE"), now, "bpm", {
      type: "PULSE",
      tz: pulseTz,
    }),
  );
  // Weight and glucose are canonical here and carry no unit: the reader's
  // unit is attached where the signal is converted for the prompt
  // (`featuresInReaderUnits`), so no canonical symbol can leak into one.
  push(buildSignal("weight", "weight", byType("WEIGHT"), now));
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
