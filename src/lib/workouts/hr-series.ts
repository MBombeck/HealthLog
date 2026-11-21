/**
 * Per-workout heart-rate curve — one server code path, one DTO with
 * explicit provenance.
 *
 * Source priority (strict):
 *   1. `WorkoutSamples` (stored series) — the session's own sensor
 *      stream, highest fidelity. Used whenever the parsed series yields
 *      ≥ 2 usable HR points.
 *   2. Pulse-window reconstruction — raw `PULSE` measurement rows in
 *      `[startedAt − 5 min, endedAt + 5 min]`, bucketed at session
 *      grain. Only attempted for workouts younger than the dense
 *      retention window (beyond it only hourly folds survive, which are
 *      useless for a session curve), and only when the fallback quality
 *      gate passes.
 *   3. Nothing — the caller hides the HR-curve card. The avg/max/min
 *      aggregates already live in the stats grid; an empty chart lies.
 *
 * The fallback gate keeps the same posture as the tension detector:
 * silence over speculation. A watchless ride with two opportunistic BPM
 * readings must not paint a two-point "curve".
 */
import { prisma } from "@/lib/db";
import { median } from "@/lib/stats/central";

/** Dense raw-PULSE retention. Older days keep only hourly folds. */
const DENSE_INTRADAY_RETENTION_DAYS = 90;
/** ± padding around the session for the fallback window. */
const WINDOW_PAD_MS = 5 * 60 * 1000;
/** Defensive read cap — dense accounts emit ~1 PULSE sample/second. */
const MAX_WINDOW_PULSE_ROWS = 6000;
/** Fallback gate: raw samples required in the padded window. */
const MIN_FALLBACK_SAMPLES = 8;
/** Fallback gate: fraction of session buckets that must be non-empty. */
const MIN_BUCKET_COVERAGE = 0.4;
/** Envelope band renders once buckets are dense enough to be meaningful. */
const ENVELOPE_MIN_MEDIAN_DENSITY = 3;

export type HrSeriesSource = "workout_series" | "pulse_window";

export interface HrSeriesPoint {
  /** Elapsed seconds from the workout start (bucket left edge). */
  tSec: number;
  mean: number;
  min: number;
  max: number;
}

export interface WorkoutHrSeries {
  source: HrSeriesSource;
  bucketSec: number;
  points: HrSeriesPoint[];
  /**
   * True when per-bucket density supports a min→max envelope band —
   * this is what makes intervals read as spiky instead of averaged
   * away. Below the threshold the chart draws the mean line only.
   */
  envelope: boolean;
}

interface RawHrSample {
  tMs: number;
  hr: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Adaptive bucket width targeting a constant on-screen density: a
 * 20-minute HIIT and a 6-hour ride both land at ≤ ~240–480 points.
 */
export function adaptiveBucketSec(durationSec: number): number {
  return clamp(Math.ceil(durationSec / 240), 5, 60);
}

/**
 * The session's own length on the wall clock.
 *
 * `durationSec` is a denormalised DURATION, and not every source reports
 * the elapsed one — Strava sends `moving_time` while the row's `endedAt`
 * is `startedAt + elapsed_time` (`src/lib/strava/client.ts`). A ride with
 * twenty minutes of stops therefore carries a `durationSec` twenty
 * minutes shorter than its own span, and a curve folded against it ends
 * at the moving-time mark with no gap and no marker: the tail of the
 * session simply is not there. The curve covers the session, so the span
 * is what it folds over.
 *
 * The duration stays the floor. A row whose `endedAt` is not after its
 * `startedAt` (a manual entry saved with one timestamp, a provider that
 * shipped an end it could not resolve) has no usable span, and every
 * source that computes `endedAt` from the duration lands on the same
 * number either way.
 */
export function sessionSpanSec(
  startedAt: Date,
  endedAt: Date,
  durationSec: number,
): number {
  const floor = Math.max(0, durationSec);
  const span = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  return Number.isFinite(span) && span > floor ? span : floor;
}

/**
 * Fold raw HR samples into session-grain buckets. Samples outside the
 * session window `[0, spanSec)` are dropped from the curve (they only
 * widen the DB query so a boundary reading still lands in bucket 0 / the
 * last bucket). Empty buckets stay as gaps — no interpolation.
 * Pure; exported for unit testing.
 */
export function foldHrBuckets(
  samples: readonly RawHrSample[],
  startMs: number,
  spanSec: number,
  bucketSec: number,
): { points: HrSeriesPoint[]; bucketCount: number; medianDensity: number } {
  const bucketCount = Math.max(1, Math.ceil(spanSec / bucketSec));
  const acc = new Map<
    number,
    { sum: number; min: number; max: number; n: number }
  >();
  for (const s of samples) {
    const rel = (s.tMs - startMs) / 1000;
    if (rel < 0 || rel >= spanSec) continue;
    const idx = Math.floor(rel / bucketSec);
    const bucket = acc.get(idx);
    if (bucket) {
      bucket.sum += s.hr;
      bucket.n += 1;
      if (s.hr < bucket.min) bucket.min = s.hr;
      if (s.hr > bucket.max) bucket.max = s.hr;
    } else {
      acc.set(idx, { sum: s.hr, min: s.hr, max: s.hr, n: 1 });
    }
  }
  const points: HrSeriesPoint[] = [];
  const densities: number[] = [];
  for (const [idx, b] of [...acc.entries()].sort((a, c) => a[0] - c[0])) {
    points.push({
      tSec: idx * bucketSec,
      mean: Math.round(b.sum / b.n),
      min: b.min,
      max: b.max,
    });
    densities.push(b.n);
  }
  return { points, bucketCount, medianDensity: median(densities) ?? 0 };
}

/**
 * Parse the stored `WorkoutSamples.samples` JSONB into usable HR
 * samples. The blob is validated at ingest against
 * `workoutHrSamplesSchema`, so this stays a lean, defensive read rather
 * than a full re-validation of up to 30 000 rows.
 */
function parseStoredSamples(raw: unknown): RawHrSample[] {
  if (!Array.isArray(raw)) return [];
  const out: RawHrSample[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const hr = rec.hr;
    const t = rec.t;
    if (typeof hr !== "number" || !Number.isFinite(hr)) continue;
    if (typeof t !== "string") continue;
    const tMs = Date.parse(t);
    if (!Number.isFinite(tMs)) continue;
    out.push({ tMs, hr });
  }
  return out;
}

export interface WorkoutHrSeriesInput {
  userId: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  storedSamples: unknown;
  /** Reference clock for the retention cut — defaults to `now`. */
  now?: Date;
}

/**
 * Resolve the workout's HR curve. Returns `null` when neither a stored
 * series nor an adequate pulse window exists.
 */
export async function buildWorkoutHrSeries(
  input: WorkoutHrSeriesInput,
): Promise<WorkoutHrSeries | null> {
  const { userId, startedAt, endedAt, durationSec, storedSamples } = input;
  const now = input.now ?? new Date();
  const startMs = startedAt.getTime();
  // Fold over the session's span, not its duration — see `sessionSpanSec`.
  // The bucket width tracks the span too, so a stop-heavy ride keeps the
  // same on-screen point density as a continuous one of the same length.
  const spanSec = sessionSpanSec(startedAt, endedAt, durationSec);
  const bucketSec = adaptiveBucketSec(spanSec);

  // 1. Stored series — the native, highest-fidelity path.
  const stored = parseStoredSamples(storedSamples);
  if (stored.length >= 2) {
    const { points, medianDensity } = foldHrBuckets(
      stored,
      startMs,
      spanSec,
      bucketSec,
    );
    if (points.length >= 2) {
      return {
        source: "workout_series",
        bucketSec,
        points,
        envelope: medianDensity >= ENVELOPE_MIN_MEDIAN_DENSITY,
      };
    }
  }

  // 2. Pulse-window fallback — only within the dense-retention horizon.
  const ageDays = (now.getTime() - startMs) / (24 * 60 * 60 * 1000);
  if (ageDays > DENSE_INTRADAY_RETENTION_DAYS) return null;

  const windowStart = new Date(startMs - WINDOW_PAD_MS);
  const windowEnd = new Date(endedAt.getTime() + WINDOW_PAD_MS);
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "PULSE",
      deletedAt: null,
      measuredAt: { gte: windowStart, lte: windowEnd },
    },
    orderBy: { measuredAt: "asc" },
    take: MAX_WINDOW_PULSE_ROWS,
    select: { value: true, measuredAt: true, externalId: true },
  });

  // Raw per-sample rows only — a consolidated `stats:` fold is a day
  // shape, not a session reading.
  const raw: RawHrSample[] = rows
    .filter((r) => !r.externalId?.startsWith("stats:"))
    .map((r) => ({ tMs: r.measuredAt.getTime(), hr: r.value }));

  // Gate part 1: enough raw samples in the padded window.
  if (raw.length < MIN_FALLBACK_SAMPLES) return null;

  const { points, bucketCount, medianDensity } = foldHrBuckets(
    raw,
    startMs,
    spanSec,
    bucketSec,
  );

  // Gate part 2: enough of the session is actually covered.
  if (points.length / bucketCount < MIN_BUCKET_COVERAGE) return null;
  if (points.length < 2) return null;

  return {
    source: "pulse_window",
    bucketSec,
    points,
    envelope: medianDensity >= ENVELOPE_MIN_MEDIAN_DENSITY,
  };
}
