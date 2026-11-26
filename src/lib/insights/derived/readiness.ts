/**
 * v1.10.0 — Wellness / readiness index (catalogue metric #7, COMPOSITE).
 *
 * A daily "how recovered are you" proxy, framed as a wellness index, with
 * every contributing component SHOWN. It extends the existing
 * `health-score.ts` weighted-blend + null-redistribution pattern with
 * deviation-from-baseline components:
 *
 *   - **RHR deviation**   — resting HR below/at baseline scores high;
 *                           an elevation suppresses the score.
 *   - **HRV deviation**   — SDNN at/above baseline scores high; a drop
 *                           suppresses it. (Surfaced as "HRV (SDNN)" — it
 *                           is NEVER relabelled RMSSD, and this is never
 *                           called "Recovery".)
 *   - **Sleep adequacy**  — the Sleep Score (#6) folded in as a 0..100
 *                           component (stubbed behind coverage so this
 *                           builds independently and lights up when sleep
 *                           data exists).
 *   - **Respiratory-rate stability** — closeness to the personal baseline.
 *   - **Mood stability**  — the existing mood-aggregate stability score.
 *
 * Each component is 0..100; weights renormalise over the PRESENT components
 * (exactly as the health score redistributes a null pillar). Below the
 * minimum-inputs floor (`minInputs = 2`) it returns `insufficient` — never
 * a headline from 1-of-N. The overnight-HR-return contributor is dropped
 * (needs intra-night HR — absent from the schema).
 *
 * Standard: RHR elevation + HRV suppression as recovery/strain markers —
 * Plews et al. 2013, Sports Medicine 43(9):773–781; Buchheit 2014,
 * Frontiers in Physiology 5:73. Framing: our own heuristic — a daily
 * wellness proxy, NOT a training-recovery score, NOT clinical.
 *
 * Server-only — reads the rollup tier (via the baseline engine) + the
 * sleep score + mood aggregates. The pure blend is exported for tests.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { computeMoodStability } from "@/lib/insights/mood-aggregates";
import { MS_PER_DAY } from "@/lib/time-constants";
import { hourInTz, shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { bandForScoreKind } from "@/lib/analytics/score/shared";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import { computeVitalsBaseline, type BaselineProfile } from "./baseline";
import { readLatestDayMean } from "./coincident-deviation";
import { wakeDayKeyOf } from "./recovery-resolve";
import { computeSleepScore } from "./sleep-score";
import {
  SPARKLINE_MAX_POINTS,
  type Derived,
  type DerivedProvenanceSource,
} from "./types";

const DEFAULT_WINDOW_DAYS = 30;
/** Minimum present components before a headline is produced (no 1-of-N). */
export const READINESS_MIN_COMPONENTS = 2;

/** Transparent component weights (renormalised over present components). */
export const READINESS_WEIGHTS = {
  rhr: 0.25,
  hrv: 0.25,
  sleep: 0.25,
  respiratory: 0.1,
  mood: 0.15,
} as const;

export type ReadinessComponentKey = keyof typeof READINESS_WEIGHTS;

/** One readiness contributor the anatomy view ranks by impact. */
export interface ReadinessComponent {
  key: ReadinessComponentKey;
  /** 0..100, or null when the input is missing (drops from the blend). */
  value: number | null;
  /** Effective weight after null-redistribution, 0..1. */
  weight: number;
}

export interface ReadinessValue {
  score: number;
  band: "green" | "yellow" | "red";
  components: ReadinessComponent[];
  /**
   * v1.42 — the blend's own course over the window (oldest → newest, capped
   * to `SPARKLINE_MAX_POINTS`), read from what the nightly job persisted; see
   * `readReadinessHistory`. Attached by the derived dispatch for the surfaces
   * that show it, absent on the job's own compute. Additive.
   */
  series?: number[];
  /**
   * 1.50 — the local calendar day (`YYYY-MM-DD`, in the account's zone)
   * `score` belongs to. On a fresh blend it is today. Otherwise it is the
   * wake day of the last readiness the nightly job stored, and `score` is
   * that stored value, never a live blend of inputs from different days.
   * Additive.
   */
  asOfDay: string;
  /**
   * 1.50 — true when every input the account still delivers is from the
   * reader's own today: each vital (resting pulse, HRV, respiratory rate)
   * and the night the sleep score describes. An input last seen before
   * yesterday, or yesterday once the local morning is over, has gone quiet
   * and is left out of the blend rather than holding it stale; mood carries
   * no day and never counts. A blend that is not fresh is not a statement
   * about today: a surface shows no number, no band and no sentence for it,
   * only "last <score> on <asOfDay>", and no component carries a value.
   * Additive.
   */
  fresh: boolean;
}

/**
 * The readiness blend's history, without recomputing a single day.
 *
 * The nightly recovery job persists exactly this blend — `computeRecoveryScore`
 * delegates to `computeReadiness` verbatim — as the `COMPUTED`-source
 * `RECOVERY_SCORE` row. Those rows ARE the readiness score of each past night.
 * A device-native recovery row (WHOOP, Oura, Polar) shares the type but is the
 * vendor's number, not this blend, so the read is held to `COMPUTED`.
 */
export async function readReadinessHistory(
  userId: string,
  now: Date,
  windowDays: number,
): Promise<number[]> {
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "RECOVERY_SCORE" satisfies MeasurementType,
      source: "COMPUTED",
      deletedAt: null,
      measuredAt: {
        gte: new Date(now.getTime() - windowDays * MS_PER_DAY),
        lte: now,
      },
    },
    select: { value: true },
    orderBy: { measuredAt: "desc" },
    take: SPARKLINE_MAX_POINTS,
  });
  return rows.map((row) => Math.round(row.value)).reverse();
}

// ── pure deviation scorers (exported for tests) ────────────────────────

function clamp100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Map a today-vs-baseline deviation to a 0..100 component score. `spread`
 * is the band half-width (k·MAD·σ-scale from the baseline engine); a value
 * one spread in the "bad" direction lands near 50, two spreads near 0.
 *
 * `direction = "lower-better"` (RHR, respiratory rate): a value above
 * baseline suppresses the score. `direction = "higher-better"` (HRV): a
 * value below baseline suppresses it. On-baseline (or in the good
 * direction) scores 100.
 */
export function scoreDeviation(
  today: number,
  center: number,
  spread: number,
  direction: "lower-better" | "higher-better",
): number {
  if (!Number.isFinite(spread) || spread <= 0) {
    // No usable spread → degrade to a coarse same/above/below.
    if (today === center) return 100;
    const worse =
      direction === "lower-better" ? today > center : today < center;
    return worse ? 50 : 100;
  }
  const worseDelta =
    direction === "lower-better" ? today - center : center - today;
  if (worseDelta <= 0) return 100; // at or in the good direction.
  // 1 spread worse → 50, 2 spreads → 0 (linear).
  return clamp100(100 - (worseDelta / spread) * 50);
}

/**
 * Blend the present components with null-redistribution (the
 * `health-score.ts` pattern). Returns the composite + per-component
 * effective weights for the anatomy view. Pure.
 */
export function blendReadinessComponents(
  raw: Record<ReadinessComponentKey, number | null>,
): { score: number; components: ReadinessComponent[] } {
  const keys = Object.keys(READINESS_WEIGHTS) as ReadinessComponentKey[];
  const present = keys.filter((k) => raw[k] !== null);
  const totalBaseWeight = present.reduce((s, k) => s + READINESS_WEIGHTS[k], 0);
  const components: ReadinessComponent[] = keys.map((k) => ({
    key: k,
    value: raw[k],
    weight:
      raw[k] === null || totalBaseWeight === 0
        ? 0
        : READINESS_WEIGHTS[k] / totalBaseWeight,
  }));
  let composite = 0;
  for (const c of components) {
    if (c.value !== null) composite += c.value * c.weight;
  }
  return { score: clamp100(composite), components };
}

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Score one baseline-deviation vital component (RHR / HRV / respiratory).
 *
 * null-vs-0 contract (iOS v0.14.3 F2)
 * -----------------------------------
 * A contributor is `null` ONLY when there is no usable signal: the baseline
 * is not established (insufficient history / band failed), there is no recent
 * reading, or the inputs are non-finite. A `null` contributor drops from the
 * blend and the client hides it. A FINITE number — including a genuine `0` —
 * means the baseline IS established and the latest reading really does deviate
 * that far (≥ 2 spreads in the unfavourable direction maps to 0; see
 * `scoreDeviation`). We deliberately never emit `0` as a "missing data"
 * sentinel: the previous behaviour of letting a non-finite `today`/`center`
 * fall through `clamp100` could surface a misleading 0 for an account that had
 * the metric but no scorable baseline — that case is now `null`.
 */
async function scoreVitalDeviation(
  userId: string,
  profile: BaselineProfile,
  type: MeasurementType,
  direction: "lower-better" | "higher-better",
  windowDays: number,
  now: Date,
  coverage: RollupCoverageMap,
  tz: string,
): Promise<{
  value: number | null;
  source: DerivedProvenanceSource;
  /** Distinct history days backing this component's baseline (0 when gated). */
  historyDays: number;
  /** Local day of the day mean that was scored; null when nothing scored. */
  day: string | null;
}> {
  const baseline = await computeVitalsBaseline(userId, profile, {
    type,
    windowDays,
    now,
    coverage,
  });
  if (baseline.status !== "ok") {
    return {
      value: null,
      source: baseline.provenance.source,
      historyDays: baseline.coverage.historyDays,
      day: null,
    };
  }
  const latest = await readLatestDayMean(userId, type, windowDays, now, tz, {
    plausibleOnly: false,
  });
  const today = latest?.value ?? null;
  // No recent reading, or a non-finite baseline center / today value: there
  // is no scorable deviation. Return null (hidden) rather than letting a NaN
  // fall through `scoreDeviation` → `clamp100`, which would surface a
  // misleading 0 for an account that actually has the metric (iOS F2).
  if (
    today == null ||
    !Number.isFinite(today) ||
    !Number.isFinite(baseline.value.center)
  ) {
    return {
      value: null,
      source: baseline.provenance.source,
      historyDays: baseline.coverage.historyDays,
      day: null,
    };
  }
  const value = scoreDeviation(
    today,
    baseline.value.center,
    baseline.value.spread,
    direction,
  );
  return {
    value,
    source: baseline.provenance.source,
    historyDays: baseline.coverage.historyDays,
    day: latest?.day ?? null,
  };
}

// ── compute ─────────────────────────────────────────────────────────────

export interface ReadinessOpts {
  windowDays?: number;
  now?: Date;
  /** Pre-probed coverage (shared across metrics in one request). */
  coverage?: RollupCoverageMap;
  /**
   * IANA timezone the "same day" grouping is keyed in, so a 23:30-local
   * reading lands on the correct readiness day, and the reader's "today"
   * that `fresh` is measured against. Omitted, the account's stored zone is
   * resolved (the production path); the sleep score reads the same zone.
   */
  tz?: string;
  /**
   * The nightly job's own compute: answer the live blend even when it is not
   * fresh, because that blend is what the job stores for the day. Every
   * display path leaves this off and gets the stored value of the named day
   * instead (`fresh`, `asOfDay`).
   */
  blendOnly?: boolean;
}

/**
 * Compute the wellness/readiness index. Below `READINESS_MIN_COMPONENTS`
 * present components it returns `insufficient` (no 1-of-N headline).
 */
export async function computeReadiness(
  userId: string,
  profile: BaselineProfile,
  opts: ReadinessOpts = {},
): Promise<Derived<ReadinessValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? (await resolveUserTimezone(userId));
  const computedAt = nowProvenanceTimestamp(now);
  const coverage = opts.coverage ?? (await probeRollupCoverage(userId));

  const inputNames = [
    "RESTING_HEART_RATE",
    "HEART_RATE_VARIABILITY",
    "SLEEP_DURATION",
    "RESPIRATORY_RATE",
    "MOOD",
  ];

  // Vital deviations (shared coverage map → one probe per request).
  const [rhr, hrv, resp] = await Promise.all([
    scoreVitalDeviation(
      userId,
      profile,
      "RESTING_HEART_RATE",
      "lower-better",
      windowDays,
      now,
      coverage,
      tz,
    ),
    scoreVitalDeviation(
      userId,
      profile,
      "HEART_RATE_VARIABILITY",
      "higher-better",
      windowDays,
      now,
      coverage,
      tz,
    ),
    scoreVitalDeviation(
      userId,
      profile,
      "RESPIRATORY_RATE",
      "lower-better",
      windowDays,
      now,
      coverage,
      tz,
    ),
  ]);

  // Sleep adequacy — folds the Sleep Score in (stubbed behind coverage:
  // null when there is no scorable night, dropping the component).
  const sleep = await computeSleepScore(userId, profile, {
    windowDays,
    now,
    tz,
  });

  const todayKey = userDayKey(now, tz);
  const sleepNight = dropQuietInputs(
    [rhr, hrv, resp],
    sleep.status === "ok" ? sleep.value.night : null,
    todayKey,
    hourInTz(now, tz),
  );
  const sleepValue =
    sleep.status === "ok" && sleepNight !== null ? sleep.value.score : null;
  const sleepHistoryDays =
    sleep.status === "ok" && sleepNight !== null
      ? sleep.coverage.historyDays
      : 0;

  // Mood stability — reuse the shipped mood-aggregate stability score over
  // the window's daily means.
  const mood = await readMoodStability(userId, windowDays, now);
  const moodValue = mood.value;

  const raw: Record<ReadinessComponentKey, number | null> = {
    rhr: rhr.value,
    hrv: hrv.value,
    sleep: sleepValue,
    respiratory: resp.value,
    mood: moodValue,
  };

  const { score, components } = blendReadinessComponents(raw);
  const presentCount = components.filter((c) => c.value !== null).length;
  const missing = components.filter((c) => c.value === null).map((c) => c.key);

  // The REAL history depth backing the composite. v1.10.0 QA: this used to be
  // pinned to `windowDays` (the constant), so `historyFraction` was always 1
  // and a 7-day blend reported the same confidence as a 30-day one. Take the
  // history of the deepest PRESENT component — the blend is at least as
  // well-backed as its best-supported contributor — so confidence reflects
  // actual depth.
  const presentHistories: number[] = [];
  if (rhr.value !== null) presentHistories.push(rhr.historyDays);
  if (hrv.value !== null) presentHistories.push(hrv.historyDays);
  if (resp.value !== null) presentHistories.push(resp.historyDays);
  if (sleepValue !== null) presentHistories.push(sleepHistoryDays);
  if (moodValue !== null) presentHistories.push(mood.historyDays);
  const compositeHistoryDays =
    presentHistories.length > 0 ? Math.max(...presentHistories) : 0;

  // Provenance source (#6): DAY when any PRESENT input read the rollup tier,
  // else live. The previous form looked only at RHR/HRV/resp; a blend backed
  // solely by sleep + mood (both live reads) mislabelled as DAY whenever one
  // of the three gated vitals happened to resolve to DAY despite contributing
  // nothing. Fold sleep + mood provenance in so the chip matches what
  // actually backed the headline.
  const presentSources: DerivedProvenanceSource[] = [];
  if (rhr.value !== null) presentSources.push(rhr.source);
  if (hrv.value !== null) presentSources.push(hrv.source);
  if (resp.value !== null) presentSources.push(resp.source);
  // Sleep + mood are live-SQL reads (no rollup tier for per-stage sleep rows
  // or mood entries), so a present sleep/mood component contributes "live".
  if (sleepValue !== null) presentSources.push(sleep.provenance.source);
  if (moodValue !== null) presentSources.push("live");
  const source: DerivedProvenanceSource =
    presentCount === 0
      ? "none"
      : presentSources.includes("DAY")
        ? "DAY"
        : "live";

  if (presentCount < READINESS_MIN_COMPONENTS) {
    // Too few inputs left once the quiet ones dropped out (after local noon
    // yesterday's readings all have). A surface keeps "last N on D" from the
    // stored row all day rather than losing the tile; the nightly job's own
    // blend has nothing to blend.
    const last = opts.blendOnly
      ? null
      : await readStaleReadiness(
          userId,
          now,
          windowDays,
          tz,
          todayKey,
          components,
        );
    if (last !== null) {
      const { coverage: cov, confidence } = deriveCoverage({
        requiredInputs: components.length,
        presentInputs: presentCount,
        historyDays: 0,
        missing,
        fullHistoryDays: windowDays,
      });
      return buildOk<ReadinessValue>({
        value: {
          score: last.score,
          band: bandForScoreKind("readiness", last.score),
          components: last.components,
          asOfDay: last.asOfDay,
          fresh: false,
        },
        coverage: cov,
        confidence,
        provenance: { inputs: inputNames, source, windowDays, computedAt },
      });
    }
    const { coverage: cov } = deriveCoverage({
      requiredInputs: components.length,
      presentInputs: presentCount,
      historyDays: 0,
      missing,
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<ReadinessValue>({
      coverage: cov,
      provenance: { inputs: inputNames, source, windowDays, computedAt },
      reason: "insufficient_components",
    });
  }

  const { coverage: cov, confidence } = deriveCoverage({
    requiredInputs: components.length,
    presentInputs: presentCount,
    historyDays: compositeHistoryDays,
    missing,
    fullHistoryDays: windowDays,
  });

  const presentInputNames = inputNames.filter((_, i) => {
    const key = (
      ["rhr", "hrv", "sleep", "respiratory", "mood"] as ReadinessComponentKey[]
    )[i];
    return raw[key] !== null;
  });

  const blendDay = readinessFreshness({
    vitalDays: [rhr, hrv, resp]
      .filter((v) => v.value !== null)
      .map((v) => v.day),
    sleepNight,
    todayKey,
  });
  const fresh = blendDay.fresh;

  // Not fresh: the live blend mixes days, so no surface may print it. The
  // value that was computed for a day is the row the nightly job stored for
  // it; name that one, or nothing.
  const shown =
    fresh || opts.blendOnly
      ? { score, asOfDay: blendDay.asOfDay, components }
      : await readStaleReadiness(
          userId,
          now,
          windowDays,
          tz,
          todayKey,
          components,
        );
  if (shown === null) {
    return buildInsufficient<ReadinessValue>({
      coverage: cov,
      provenance: { inputs: inputNames, source, windowDays, computedAt },
      reason: "not_fresh",
    });
  }

  return buildOk<ReadinessValue>({
    value: {
      score: shown.score,
      band: bandForScoreKind("readiness", shown.score),
      components: shown.components,
      asOfDay: shown.asOfDay,
      fresh,
    },
    coverage: cov,
    confidence,
    provenance: {
      inputs: presentInputNames.length > 0 ? presentInputNames : inputNames,
      source,
      windowDays,
      computedAt,
    },
  });
}

/**
 * How old one dated input is for the blend of `todayKey`: from today;
 * "pending" when it is from yesterday and the local morning (before noon) is
 * not over, so the night or the morning's readings may still sync; "quiet"
 * otherwise, and a quiet input is left out of the blend. Pure; exported for
 * tests.
 */
export const READINESS_PENDING_UNTIL_HOUR = 12;

export function readinessInputAge(
  day: string | null,
  todayKey: string,
  localHour: number,
): "today" | "pending" | "quiet" {
  if (day === todayKey) return "today";
  if (
    day === shiftDateKey(todayKey, -1) &&
    localHour < READINESS_PENDING_UNTIL_HOUR
  ) {
    return "pending";
  }
  return "quiet";
}

/**
 * Leave an input that has gone quiet out of the blend like a missing one, so
 * a sensor the account stopped wearing lowers the coverage instead of
 * holding readiness stale for the rest of the window. Clears each quiet
 * vital in place and answers the sleep night that still counts, or null.
 */
function dropQuietInputs(
  vitals: { value: number | null; day: string | null }[],
  night: string | null,
  todayKey: string,
  localHour: number,
): string | null {
  const quiet = (day: string | null) =>
    readinessInputAge(day, todayKey, localHour) === "quiet";
  for (const vital of vitals) {
    if (vital.value !== null && quiet(vital.day)) {
      vital.value = null;
      vital.day = null;
    }
  }
  return night !== null && !quiet(night) ? night : null;
}

/**
 * A stale readiness as surfaces show it: the score stored for its day, that
 * day, and every component listed without a value (the stored row keeps no
 * breakdown, and today's contributors are not that day's). Null when no
 * stored day before today exists to name.
 */
async function readStaleReadiness(
  userId: string,
  now: Date,
  windowDays: number,
  tz: string,
  todayKey: string,
  components: ReadinessComponent[],
): Promise<{
  score: number;
  asOfDay: string;
  components: ReadinessComponent[];
} | null> {
  const last = await readLastStoredReadiness(
    userId,
    now,
    windowDays,
    tz,
    todayKey,
  );
  if (last === null) return null;
  return {
    score: last.score,
    asOfDay: last.day,
    components: components.map((c) => ({ key: c.key, value: null, weight: 0 })),
  };
}

/**
 * The last readiness the nightly job stored for a day before today, with
 * the local wake day it belongs to (the day the day view shows it on). Null
 * when none is in the window.
 *
 * Never today's row: the nightly job runs before the morning's readings
 * sync and files a blend of yesterday's values under today's wake day, so
 * "last 81 on <today>" beside an empty ring would name today for numbers
 * that are not today's. A stored row's wake day is its stamp plus one day
 * (`wakeDayKeyOf`, the COMPUTED day-that-ended stamp), so a wake day before
 * today is a stamp before the start of today minus one day.
 */
async function readLastStoredReadiness(
  userId: string,
  now: Date,
  windowDays: number,
  tz: string,
  todayKey: string,
): Promise<{ score: number; day: string } | null> {
  const row = await prisma.measurement.findFirst({
    where: {
      userId,
      type: "RECOVERY_SCORE" satisfies MeasurementType,
      source: "COMPUTED",
      deletedAt: null,
      measuredAt: {
        gte: new Date(now.getTime() - windowDays * MS_PER_DAY),
        lt: new Date(startOfLocalDayKey(todayKey, tz).getTime() - MS_PER_DAY),
      },
    },
    select: { value: true, measuredAt: true, source: true },
    orderBy: { measuredAt: "desc" },
  });
  if (!row || !Number.isFinite(row.value)) return null;
  return {
    score: clamp100(row.value),
    day: wakeDayKeyOf(row.measuredAt, row.source, tz),
  };
}

/**
 * Which day a blend rests on, and whether that day is today. Every counted
 * vital's scored day and the sleep score's night (its wake day) are dated;
 * `asOfDay` is the oldest of them, so a blend is fresh exactly when that
 * oldest day is the reader's today. A counted vital without a day cannot
 * vouch for today and makes the blend stale. Pure; exported for tests.
 */
export function readinessFreshness(args: {
  vitalDays: readonly (string | null)[];
  sleepNight: string | null;
  todayKey: string;
}): { asOfDay: string; fresh: boolean } {
  const days = [...args.vitalDays];
  if (args.sleepNight !== null) days.push(args.sleepNight);
  const dated = days.filter((d): d is string => d !== null);
  if (dated.length === 0) return { asOfDay: args.todayKey, fresh: false };
  const asOfDay = dated.reduce((a, b) => (b < a ? b : a));
  return {
    asOfDay,
    fresh: dated.length === days.length && asOfDay === args.todayKey,
  };
}

/**
 * Mood stability over the window — reads daily-mean mood and feeds the
 * shipped `computeMoodStability` (0..100, higher = steadier). Null below
 * the stability floor.
 */
async function readMoodStability(
  userId: string,
  windowDays: number,
  now: Date,
): Promise<{ value: number | null; historyDays: number }> {
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);
  const rows = await prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "asc" },
    take: 2000,
    select: { score: true, moodLoggedAt: true },
  });
  if (rows.length === 0) return { value: null, historyDays: 0 };
  // Collapse to daily means keyed by dayOffset (newest = 0), matching the
  // mood-aggregate DailyPoint shape.
  const byDay = new Map<number, { sum: number; count: number }>();
  for (const r of rows) {
    const offset = Math.floor(
      (now.getTime() - r.moodLoggedAt.getTime()) / MS_PER_DAY,
    );
    const acc = byDay.get(offset) ?? { sum: 0, count: 0 };
    acc.sum += r.score;
    acc.count += 1;
    byDay.set(offset, acc);
  }
  const daily = [...byDay.entries()].map(([dayOffset, acc]) => ({
    dayOffset,
    value: acc.sum / acc.count,
  }));
  const stability = computeMoodStability(daily);
  return {
    value: stability ? stability.score : null,
    historyDays: daily.length,
  };
}
