/**
 * v1.10.0 — computed scores (WX-E). Nightly Stress-score computation + store.
 *
 * Once a night this cron computes each eligible user's Stress score from
 * their intra-day `HEART_RATE_VARIABILITY` (SDNN) samples and persists it as
 * a `COMPUTED STRESS_SCORE` Measurement row (see
 * `src/lib/insights/stress-score.ts`). The score is an HONEST HRV-derived
 * proxy — Apple Watch has no EDA sensor; it is NEVER a direct stress
 * measurement. The score is never computed on a page visit.
 *
 * Idempotent per user per day: the per-user persist upserts on
 * `(userId, type, source, externalId)` with `externalId = stress:YYYY-MM-DD`,
 * so a re-fired cron tick (or a manual re-run) overwrites the day's row in
 * place. A user without enough intra-day SDNN samples or a usable baseline
 * gets NO row that night — the series stays honest.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot; an
 * unregistered queue silently never drains.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { persistStressScore } from "@/lib/insights/stress-score";
import { runScoreBatch } from "@/lib/insights/score-row";
import { excludePendingOwners } from "@/lib/account-deletion/active-account";

/** Per-run user cap — same starvation guard the recovery-score pass uses. */
export const STRESS_SCORE_BATCH_CAP = 500;

/** Trailing window (days) a user must have a recent HRV row in to be a candidate. */
export const STRESS_SCORE_RECENCY_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StressScoreRunResult {
  considered: number;
  stored: number;
  insufficient: number;
  errored: number;
}

/**
 * Discover users worth scoring tonight: anyone with at least one LIVE
 * `HEART_RATE_VARIABILITY` row in the recency window. A user with no recent
 * HRV cannot produce a Stress proxy, so skipping them keeps the pass cheap.
 * Bounded by `cap`.
 */
export async function findStressScoreCandidates(
  prisma: PrismaClient,
  now: Date,
  cap: number,
): Promise<string[]> {
  const since = new Date(
    now.getTime() - STRESS_SCORE_RECENCY_DAYS * MS_PER_DAY,
  );
  // Deterministic recency-under-cap: group by user, newest HRV first, `userId`
  // tiebreak. `distinct` + `take` without an order picks an arbitrary set when
  // more than `cap` users qualify; `groupBy` makes the cap take the
  // most-recently-active users every run.
  const rows = await prisma.measurement.groupBy({
    by: ["userId"],
    where: {
      type: "HEART_RATE_VARIABILITY",
      deletedAt: null,
      measuredAt: { gte: since },
      ...(await excludePendingOwners(prisma)),
    },
    orderBy: [{ _max: { measuredAt: "desc" } }, { userId: "asc" }],
    take: cap,
  });
  return rows.map((r) => r.userId);
}

/**
 * Run one Stress-score pass. Pure of pg-boss so the unit test drives it
 * directly. Each user is scored independently; a single user's error is
 * recorded and the pass continues.
 */
export async function runStressScore(
  prisma: PrismaClient,
  options: { now?: Date; cap?: number } = {},
): Promise<StressScoreRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? STRESS_SCORE_BATCH_CAP;

  const userIds = await findStressScoreCandidates(prisma, now, cap);

  return runScoreBatch(
    userIds,
    now,
    (userId, runNow) => persistStressScore(prisma, userId, runNow),
    "insights.stress.compute",
  );
}
