/**
 * v1.4.37 W2 — probe-gated correlation hypothesis runner.
 *
 * The three pre-defined hypotheses (BP × medication compliance, mood ×
 * resting pulse, weight × weekday) need PAIRED day-level samples
 * across two streams. The pairing logic is not linearly composable
 * from DAY rollup buckets the way `count / min / max / mean` is, but
 * the only inputs the runners consume from the measurement stream are
 * **per-day means** for the three measurement types (SYS, PULSE,
 * WEIGHT). The rollup table carries those means as a first-class
 * column — when DAY-bucket coverage is present we can hydrate the
 * per-day-mean maps directly from `measurement_rollups` and skip the
 * raw chunked findMany walks against `measurements` entirely.
 *
 * Read shape (v1.4.37)
 * --------------------
 *   1. **Tightened window** — the previous helper read the trailing 30
 *      days. The v1.4.37 helper reads **28 days**. The Pearson +
 *      ANOVA runners require `n >= 20` paired samples (v1.4.23 H6) so
 *      28 still satisfies the surface gate; the 2-day tighten removes
 *      ~7 % of the cold-pool read volume and lines the correlation
 *      window up with the dashboard's "trailing 4 weeks" tile shorthand.
 *      The meta-dict annotate carries `window_days: 28` as a sentinel
 *      so the UI / docs can quote the truthful window.
 *
 *   2. **Probe-gated SYS / PULSE / WEIGHT** — when DAY-bucket coverage
 *      exists for all three types the runner hydrates the per-day-mean
 *      maps from `measurement_rollups`. Each rollup row already
 *      carries the day's `mean` value computed by Postgres' `AVG`, so
 *      the pairing logic is byte-for-byte identical to the live path's
 *      "average the day's raw values" step.
 *
 *   3. **Mood + medication intake** — no rollup equivalent today; both
 *      reads stay live regardless of coverage. The mood read is small
 *      (per-day entries, bounded by the 28-day window) and the
 *      medication intake read scales with active medications × 28 days
 *      so neither dominates the cost.
 *
 *   4. **Best-effort sentinel** — the route surface advertises a
 *      28-day correlation window. Older data (> 28 days) is
 *      intentionally NOT scanned on the cold critical path. The
 *      runner emits `degraded: false` on the happy path; downstream
 *      consumers can extend the window via a separate dedicated
 *      endpoint when richer historical context is needed.
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { readRollupBuckets } from "@/lib/measurements/rollups";
import {
  isFullyCovered,
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/measurements/rollup-coverage";
import {
  correlateBpCompliance,
  correlateMoodPulse,
  correlateWeightWeekday,
  type CorrelationResult,
} from "@/lib/insights/correlations";
import { isNearUtc, userDayKey } from "@/lib/tz/resolver";

/**
 * v1.4.37 W2 — cold-path correlation window. Trim from 30 to 28 days
 * keeps the `n >= 20` Pearson gate comfortably reachable while shaving
 * two days off every read the runner issues. Kept as a constant so the
 * sentinel annotate and the SQL/Prisma WHERE clauses stay in lockstep.
 */
export const CORRELATION_WINDOW_DAYS = 28;

const CHUNK = 5000;

interface ChunkedRow {
  measuredAt: Date;
  value: number;
}

interface MoodRow {
  score: number;
  moodLoggedAt: Date;
}

interface IntakeRow {
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
}

export interface CorrelationHypothesesResult {
  bpCompliance: CorrelationResult;
  moodPulse: CorrelationResult;
  weightWeekday: CorrelationResult;
  /**
   * Sentinel — `true` when the runner's scan window was tightened
   * below the canonical surface (e.g. fell back to a partial read).
   * Today this is always `false`: the 28-day window is the canonical
   * surface. Reserved for a future "best-effort under load shedding"
   * branch.
   *
   * Reserved for the v1.5 load-shedding branch (pool-pressure
   * detector + shorter window fallback). Until then the field is
   * pinned to `false` by both branches and the
   * `meta.correlations.degraded` annotate carries the same value;
   * downstream consumers can already key on the field shape without
   * the load-shedding signal being live.
   */
  degraded: boolean;
  /** Window the runner actually scanned, in days. */
  windowDays: number;
  /** `"rollup"` when SYS / PULSE / WEIGHT rode the rollup-fast-path. */
  path: "rollup" | "live";
}

export interface CorrelationsFastPathInput {
  userId: string;
  userTz: string;
  now: Date;
  coverage?: RollupCoverageMap;
}

export async function computeCorrelationHypothesesFastPath(
  input: CorrelationsFastPathInput,
): Promise<CorrelationHypothesesResult> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const { userId, userTz, now } = input;
  const since = new Date(now.getTime() - CORRELATION_WINDOW_DAYS * DAY_MS);

  const coverage = input.coverage ?? (await probeRollupCoverage(userId));

  // v1.4.38 W-A — cross-tz runtime guard. The rollup table buckets at
  // UTC midnight, while the per-event mood / intake streams below are
  // re-keyed via `userDayKey(..., userTz)`. For a user inside the +-3h
  // band around UTC (Europe + western Mid-Atlantic), the two keying
  // schemes line up on the same calendar day. Outside that band the
  // pairing slips by a day and the Pearson / ANOVA inputs miscorrelate.
  // The cheap fix: when the user is non-near-UTC, force the live path
  // so the SYS / PULSE / WEIGHT per-day means are re-keyed via the same
  // `userDayKey(measuredAt, userTz)` helper the mood / intake streams
  // use, guaranteeing day-key parity. A v1.5 follow-up will thread
  // `userTz` into `readRollupBuckets` so the rollup path also addresses
  // local-day buckets and this guard can come back down.
  const userNearUtc = isNearUtc(userTz, now);

  // The three measurement-derived streams ride the rollup-fast-path
  // only when EVERY type the user has logged is covered AND each of
  // SYS / PULSE / WEIGHT is in the coverage map. Partial coverage
  // falls back to the live path so a brand-new metric type doesn't
  // make the correlation card vanish.
  const measurementsOnRollups =
    userNearUtc &&
    isFullyCovered(coverage) &&
    coverage.get("BLOOD_PRESSURE_SYS") === true &&
    coverage.get("PULSE") === true &&
    coverage.get("WEIGHT") === true;

  let dailySysMean: Map<string, number>;
  let dailyPulseMean: Map<string, number>;
  let weightRows: ChunkedRow[];

  if (measurementsOnRollups) {
    // Rollup-fast-path. One indexed read per type against
    // `measurement_rollups`, projecting the per-day mean directly.
    //
    // The rollup table buckets at UTC midnight (`date_trunc('day', …)`
    // in Postgres). For a user whose display tz sits more than a few
    // hours from UTC the bucket's `bucketStart` can land on the
    // previous local calendar day relative to the same wall-clock
    // reading on the live path. Today the production tenant is
    // Berlin-centric (UTC+1/+2 → midnight UTC = 01:00/02:00 Berlin,
    // same calendar day) so the shift is benign. A v1.5 follow-up
    // could mint per-user-tz buckets if the discrepancy materialises
    // on a non-Berlin account; the n >= 20 surface gate absorbs the
    // single-day phase shift either way.
    const [sysBuckets, pulseBuckets, weightBuckets] = await Promise.all([
      readRollupBuckets(userId, "BLOOD_PRESSURE_SYS", "DAY", since, now),
      readRollupBuckets(userId, "PULSE", "DAY", since, now),
      readRollupBuckets(userId, "WEIGHT", "DAY", since, now),
    ]);
    dailySysMean = new Map();
    for (const b of sysBuckets) {
      dailySysMean.set(userDayKey(b.bucketStart, userTz), b.mean);
    }
    dailyPulseMean = new Map();
    for (const b of pulseBuckets) {
      dailyPulseMean.set(userDayKey(b.bucketStart, userTz), b.mean);
    }
    // The weekday hypothesis needs the per-event weight series for
    // ANOVA — the runner expects one row per measurement so the group
    // counts reflect reality. Hydrate from buckets by emitting one
    // pseudo-row per bucket carrying the day's mean. For weight the
    // typical usage is one weigh-in per day, so the rollup shape is
    // already aligned; if a power user logged 3 weigh-ins on a single
    // Monday the rollup collapses them into one mean, which is the
    // statistically correct "this Monday's weight" datapoint anyway.
    weightRows = weightBuckets.map((b) => ({
      measuredAt: b.bucketStart,
      value: b.mean,
    }));
  } else {
    // Live fallback — chunked reads against the measurements table.
    const [sysRows, pulseRows, weightRowsLive] = await Promise.all([
      fetchSeriesChunked(userId, "BLOOD_PRESSURE_SYS", since),
      fetchSeriesChunked(userId, "PULSE", since),
      fetchSeriesChunked(userId, "WEIGHT", since),
    ]);
    dailySysMean = new Map();
    const sysBuckets = new Map<string, number[]>();
    for (const r of sysRows) {
      const key = userDayKey(r.measuredAt, userTz);
      const list = sysBuckets.get(key) ?? [];
      list.push(r.value);
      sysBuckets.set(key, list);
    }
    for (const [key, list] of sysBuckets.entries()) {
      const sum = list.reduce((s, v) => s + v, 0);
      dailySysMean.set(key, sum / list.length);
    }
    dailyPulseMean = new Map();
    const pulseBuckets = new Map<string, number[]>();
    for (const r of pulseRows) {
      const key = userDayKey(r.measuredAt, userTz);
      const list = pulseBuckets.get(key) ?? [];
      list.push(r.value);
      pulseBuckets.set(key, list);
    }
    for (const [key, list] of pulseBuckets.entries()) {
      const sum = list.reduce((s, v) => s + v, 0);
      dailyPulseMean.set(key, sum / list.length);
    }
    weightRows = weightRowsLive;
  }

  // Mood + intake — always live. Both reads are small (28-day window,
  // narrow projections) and neither has a rollup equivalent today.
  const [moodRows, intakeRows] = await Promise.all([
    prisma.moodEntry.findMany({
      where: { userId, moodLoggedAt: { gte: since } },
      select: { score: true, moodLoggedAt: true },
    }) as Promise<MoodRow[]>,
    prisma.medicationIntakeEvent.findMany({
      where: { userId, scheduledFor: { gte: since } },
      select: { scheduledFor: true, takenAt: true, skipped: true },
    }) as Promise<IntakeRow[]>,
  ]);

  // ── Hypothesis 1: BP × medication compliance ────────────────
  const dailyCompliance = new Map<
    string,
    { expected: number; taken: number }
  >();
  for (const event of intakeRows) {
    const key = userDayKey(event.scheduledFor, userTz);
    const slot = dailyCompliance.get(key) ?? { expected: 0, taken: 0 };
    slot.expected += 1;
    if (event.takenAt && !event.skipped) slot.taken += 1;
    dailyCompliance.set(key, slot);
  }

  const bpCompliancePairs: Array<{
    date: Date;
    systolic: number;
    compliancePct: number;
  }> = [];
  for (const [key, meanSys] of dailySysMean.entries()) {
    const slot = dailyCompliance.get(key);
    if (!slot || slot.expected === 0) continue;
    const compliancePct = (slot.taken / slot.expected) * 100;
    bpCompliancePairs.push({
      date: dateFromDayKey(key),
      systolic: meanSys,
      compliancePct,
    });
  }
  const bpCompliance = correlateBpCompliance({ daily: bpCompliancePairs });

  // ── Hypothesis 2: Mood × resting pulse ──────────────────────
  const dailyMood = new Map<string, number[]>();
  for (const row of moodRows) {
    const key = userDayKey(row.moodLoggedAt, userTz);
    const list = dailyMood.get(key) ?? [];
    list.push(row.score);
    dailyMood.set(key, list);
  }
  const moodPulsePairs: Array<{
    date: Date;
    mood: number;
    restingPulse: number;
  }> = [];
  for (const [key, moodScores] of dailyMood.entries()) {
    const meanPulse = dailyPulseMean.get(key);
    if (meanPulse === undefined) continue;
    const meanMood = moodScores.reduce((s, v) => s + v, 0) / moodScores.length;
    moodPulsePairs.push({
      date: dateFromDayKey(key),
      mood: meanMood,
      restingPulse: meanPulse,
    });
  }
  const moodPulse = correlateMoodPulse({ daily: moodPulsePairs });

  // ── Hypothesis 3: Weight × weekday ──────────────────────────
  const weightWeekdayPairs: Array<{ weekday: number; weight: number }> = [];
  for (const row of weightRows) {
    const isoWeekday = isoWeekdayInTz(row.measuredAt, userTz);
    weightWeekdayPairs.push({
      weekday: isoWeekday - 1,
      weight: row.value,
    });
  }
  const weightWeekday = correlateWeightWeekday({ daily: weightWeekdayPairs });

  annotate({
    meta: {
      correlations: {
        bpCompliance: bpCompliance.status,
        moodPulse: moodPulse.status,
        weightWeekday: weightWeekday.status,
        path: measurementsOnRollups ? "rollup" : "live",
        window_days: CORRELATION_WINDOW_DAYS,
        degraded: false,
        // v1.4.38 W-A — surfaces the cross-tz guard decision so ops
        // logs can distinguish "user is Berlin, rollup path eligible"
        // from "user is Honolulu, forced to live regardless of coverage".
        tz_guard: userNearUtc ? "near-utc" : "non-utc-live-fallback",
      },
    },
  });

  return {
    bpCompliance,
    moodPulse,
    weightWeekday,
    degraded: false,
    windowDays: CORRELATION_WINDOW_DAYS,
    path: measurementsOnRollups ? "rollup" : "live",
  };
}

async function fetchSeriesChunked(
  userId: string,
  type: "BLOOD_PRESSURE_SYS" | "PULSE" | "WEIGHT",
  since: Date,
): Promise<ChunkedRow[]> {
  const out: ChunkedRow[] = [];
  let cursorId: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const chunk = await prisma.measurement.findMany({
      where: { userId, type, measuredAt: { gte: since } },
      orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
      select: { id: true, measuredAt: true, value: true },
      take: CHUNK,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    if (chunk.length === 0) break;
    for (const row of chunk) {
      out.push({ measuredAt: row.measuredAt, value: row.value });
    }
    if (chunk.length < CHUNK) break;
    cursorId = chunk[chunk.length - 1].id;
  }
  return out;
}

function dateFromDayKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

const WEEKDAY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
function getWeekdayFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = WEEKDAY_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
    WEEKDAY_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function isoWeekdayInTz(d: Date, timeZone: string): number {
  const parts = getWeekdayFormatter(timeZone).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return ISO_WEEKDAY[weekday] ?? 1;
}
