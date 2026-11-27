/**
 * v1.10.0 — computed scores (WX-E). The Stress score ENGINE + persistence.
 *
 * HONEST FRAMING (load-bearing — read before changing the label or copy):
 * Apple Watch has NO electrodermal-activity (EDA / galvanic) sensor. There
 * is no continuous stress measurement in HealthKit. What HealthKit DOES
 * give is discrete heart-rate-variability (SDNN) samples through the day.
 * This engine derives a defensible *proxy* from the intra-day SDNN signal —
 * autonomic-balance research treats a SUPPRESSED, less-variable HRV through
 * the day as a marker of higher sympathetic ("stress") load. It is NOT a
 * direct stress measurement and the provenance/label must always say
 * "HRV-derived proxy", never imply a galvanic / EDA reading.
 *
 * The proxy (0–100, higher = more inferred stress):
 *   - Read the day's intra-day `HEART_RATE_VARIABILITY` (SDNN, ms) samples
 *     (the dense intra-day retention tier keeps these raw within its
 *     window — see `dense-intraday-retention.ts`).
 *   - Take the day's MEAN SDNN.
 *   - Compare it to the user's personal SDNN baseline (the robust
 *     median/MAD band from the shared vitals-baseline engine over a 7-day
 *     reference window). HRV is "higher-better" for recovery; a day mean
 *     BELOW baseline = HRV suppression = higher inferred stress.
 *   - Map the suppression deviation to 0–100 via the same MAD-scaled
 *     deviation scorer the readiness blend uses (one spread below baseline
 *     → ~50, two spreads → ~100), then INVERT so suppression raises stress.
 *
 * Honest confidence: the score is only stored when the day has at least
 * `STRESS_MIN_INTRADAY_SAMPLES` SDNN samples AND the SDNN baseline is
 * usable. Below that the engine returns `insufficient` and NO row is
 * written — the series never carries a headline from a single spot reading
 * or an unestablished baseline.
 *
 * Standard / framing: HRV (SDNN) suppression + reduced variability as a
 * sympathetic-load marker — Kim et al. 2018, "Stress and Heart Rate
 * Variability: A Meta-Analysis", Psychiatry Investigation 15(3):235–245;
 * Thayer et al. 2012, Neuroscience & Biobehavioral Reviews 36(2):747–756.
 * The score is descriptive — a daily wellness proxy, NOT a clinical
 * assessment, and it is excluded from the doctor PDF.
 *
 * Row shape (identical posture to the Recovery score):
 *   - `type   = STRESS_SCORE`
 *   - `source = COMPUTED`        (server-owned; a client can never POST it)
 *   - `unit   = "score"`
 *   - `value  = 0..100`          (plausibility-pinned to {min:0, max:100})
 *   - `externalId = stress:YYYY-MM-DD` (the per-day idempotency key)
 *
 * Server-only — runs from the nightly pg-boss job in
 * `src/lib/jobs/stress-score.ts`.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import {
  computeVitalsBaseline,
  loadBaselineProfile,
} from "@/lib/insights/derived/baseline";
import { scoreDeviation } from "@/lib/insights/derived/readiness";
import { pickCanonicalSourceRows } from "@/lib/analytics/source-priority";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import type { BaselineProfile } from "@/lib/insights/derived/baseline";
import {
  scoreDayKey,
  scoreExternalId,
  scoreMeasuredAt,
  upsertScoreRow,
} from "@/lib/insights/score-row";

/** The per-day idempotency-key prefix for a stored Stress score row. */
export const STRESS_SCORE_EXTERNAL_ID_PREFIX = "stress:";

/** SDNN reference window (days) for the personal baseline. */
export const STRESS_BASELINE_WINDOW_DAYS = 7;

/**
 * Minimum intra-day SDNN samples in the scored day before a headline is
 * produced. A single spot SDNN reading is not an intra-day shape; below
 * this floor the engine gates and writes nothing.
 */
export const STRESS_MIN_INTRADAY_SAMPLES = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The full `externalId` for a given run's Stress score row. */
export function stressExternalId(now: Date): string {
  return scoreExternalId(STRESS_SCORE_EXTERNAL_ID_PREFIX, now);
}

/** The canonical timestamp a stored Stress row carries (noon UTC, scored day). */
export function stressMeasuredAt(now: Date): Date {
  return scoreMeasuredAt(now);
}

/**
 * Map a day-mean SDNN below the personal baseline to a 0–100 stress proxy.
 * Reuses the readiness deviation scorer (HRV is "higher-better" for
 * recovery, so a suppression scores LOW there) and INVERTS it so HRV
 * suppression raises the stress proxy. On-or-above baseline → 0 (no
 * inferred stress); one spread below → ~50; two spreads below → ~100.
 *
 * Pure — exported for unit testing without Prisma.
 */
export function stressProxyFromSdnn(
  dayMeanSdnn: number,
  baselineCenter: number,
  baselineSpread: number,
): number {
  // `scoreDeviation(... "higher-better")` returns 100 at/above baseline and
  // falls toward 0 as SDNN drops; invert so suppression → high stress.
  const recoveryComponent = scoreDeviation(
    dayMeanSdnn,
    baselineCenter,
    baselineSpread,
    "higher-better",
  );
  return Math.max(0, Math.min(100, Math.round(100 - recoveryComponent)));
}

/**
 * The scored day's intra-day SDNN: how many raw `HEART_RATE_VARIABILITY`
 * rows the scored UTC day holds, and their mean, aggregated in Postgres per
 * source and device, of the source the ladder picks for the day. The
 * dense intra-day retention tier keeps these raw within its window, so for a
 * recently-synced day the engine sees the full intra-day set; the aggregate
 * counts every one of them, where a row read used to stop at 2 000.
 */
async function readIntradaySdnn(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<{ count: number; mean: number | null }> {
  const dayKey = scoreDayKey(now);
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: UTC day window of the UTC-day score engines (scoreDayKey)
  const dayStart = new Date(`${dayKey}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + MS_PER_DAY);
  const groups = await prisma.measurement.groupBy({
    by: ["source", "deviceType"],
    where: {
      userId,
      type: "HEART_RATE_VARIABILITY" as MeasurementType,
      deletedAt: null,
      measuredAt: { gte: dayStart, lt: dayEnd },
      // Only count raw per-sample rows toward the intra-day floor — a single
      // already-folded `stats:` daily-mean row is one point, not a shape.
      NOT: { externalId: { startsWith: "stats:" } },
    },
    orderBy: [{ source: "asc" }, { deviceType: "asc" }],
    _count: { _all: true },
    _sum: { value: true },
  });
  // A day with SDNN from two sources scores the one the person's ladder puts
  // first. The picker decides from which sources and device types are
  // present, never from the values, so it picks the same over these groups
  // as over the raw rows.
  const { canonicalRows } = pickCanonicalSourceRows(
    groups.map((g) => ({
      measuredAt: dayStart,
      source: g.source,
      deviceType: g.deviceType,
      type: "HEART_RATE_VARIABILITY" as MeasurementType,
      n: g._count._all,
      sum: g._sum.value ?? 0,
    })),
    "hrv",
    await loadUserSourcePriority(userId),
    () => dayKey,
  );
  const count = canonicalRows.reduce((acc, g) => acc + g.n, 0);
  const total = canonicalRows.reduce((acc, g) => acc + g.sum, 0);
  return { count, mean: count === 0 ? null : total / count };
}

export interface StressComputeResult {
  /** The 0..100 score to persist, or null when the inputs gate. */
  score: number | null;
  /** Why a null score gated (exposed for the job log + tests). */
  reason: "ok" | "insufficient_intraday_samples" | "insufficient_baseline";
  /** Number of intra-day SDNN samples found for the scored day. */
  intradaySamples: number;
}

/**
 * Compute the Stress score for one user as of `now`. Pure of persistence —
 * the job calls this, then writes the row. Reuses the shared vitals-baseline
 * engine (the same SDNN baseline the readiness blend reads) so the two
 * surfaces can never drift.
 */
export async function computeStressScore(
  prisma: PrismaClient,
  userId: string,
  profile: BaselineProfile,
  now: Date,
): Promise<StressComputeResult> {
  const sdnn = await readIntradaySdnn(prisma, userId, now);
  if (sdnn.count < STRESS_MIN_INTRADAY_SAMPLES || sdnn.mean === null) {
    return {
      score: null,
      reason: "insufficient_intraday_samples",
      intradaySamples: sdnn.count,
    };
  }

  const baseline = await computeVitalsBaseline(userId, profile, {
    type: "HEART_RATE_VARIABILITY",
    windowDays: STRESS_BASELINE_WINDOW_DAYS,
    now,
  });
  if (baseline.status !== "ok") {
    return {
      score: null,
      reason: "insufficient_baseline",
      intradaySamples: sdnn.count,
    };
  }

  const score = stressProxyFromSdnn(
    sdnn.mean,
    baseline.value.center,
    baseline.value.spread,
  );
  return { score, reason: "ok", intradaySamples: sdnn.count };
}

/**
 * Build the `BaselineProfile` the SDNN baseline needs from the user row. Thin
 * alias over the shared `loadBaselineProfile` so callers / tests keep the
 * name.
 */
export async function loadStressProfile(
  prisma: PrismaClient,
  userId: string,
): Promise<BaselineProfile> {
  return loadBaselineProfile(prisma, userId);
}

export interface PersistStressResult {
  /** "stored" when a row was upserted; "insufficient" when gated. */
  outcome: "stored" | "insufficient";
  /** The persisted score, or null when insufficient. */
  score: number | null;
  /** The gate reason (mirrors the compute result). */
  reason: StressComputeResult["reason"];
}

/**
 * Compute + persist one user's Stress score for the `now` day. Upserts on
 * the `(userId, type, source, externalId)` key so a re-run overwrites the
 * day's row in place rather than duplicating it. Writes NOTHING when the
 * inputs gate — no phantom proxy from a single reading or an unestablished
 * baseline. The baseline engine reads `@/lib/db` directly; the nightly job
 * passes that same shared client so both reads hit one connection.
 */
export async function persistStressScore(
  prisma: PrismaClient,
  userId: string,
  now: Date,
): Promise<PersistStressResult> {
  const profile = await loadStressProfile(prisma, userId);
  const { score, reason } = await computeStressScore(
    prisma,
    userId,
    profile,
    now,
  );

  if (score === null) {
    return { outcome: "insufficient", score: null, reason };
  }

  await upsertScoreRow(prisma, {
    userId,
    type: "STRESS_SCORE",
    externalIdPrefix: STRESS_SCORE_EXTERNAL_ID_PREFIX,
    score,
    now,
  });

  return { outcome: "stored", score, reason };
}
