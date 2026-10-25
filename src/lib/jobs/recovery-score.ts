/**
 * v1.10.0 — computed scores (WX-C). Nightly Recovery-score computation +
 * store.
 *
 * Once a night this cron computes each eligible user's Recovery score from
 * their already-stored nightly signals (RHR / HRV / sleep / respiratory
 * deviation from the personal baseline) and persists it as a `COMPUTED`
 * `RECOVERY_SCORE` Measurement row (see `src/lib/insights/recovery-score.ts`).
 * The score is NEVER computed on a page visit — the read surfaces query the
 * stored row like any other daily series.
 *
 * Idempotent per user per day: the per-user persist upserts on
 * `(userId, type, source, externalId)` with `externalId = recovery:YYYY-MM-DD`,
 * so a re-fired cron tick (or a manual re-run) overwrites the day's row in
 * place rather than duplicating it. A user whose readiness blend is below the
 * minimum-component floor gets NO row that night — the series stays honest.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot; an
 * unregistered queue silently never drains (the recurring past bug this
 * comment guards against).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { persistRecoveryScore } from "@/lib/insights/recovery-score";
import { runScoreBatch } from "@/lib/insights/score-row";
import { excludePendingOwners } from "@/lib/account-deletion/active-account";

/**
 * Per-run user cap. A nightly fan-out across every user could starve the
 * pool; the discovery query is ordered so users with the most recent vital
 * data are served first and the long tail catches up over successive nights.
 */
export const RECOVERY_SCORE_BATCH_CAP = 500;

/** Trailing window (days) a user must have a recent recovery-input row in to be a candidate. */
export const RECOVERY_SCORE_RECENCY_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RecoveryScoreRunResult {
  considered: number;
  stored: number;
  insufficient: number;
  errored: number;
}

/**
 * Discover users worth scoring tonight: anyone with at least one LIVE
 * recovery-input row (RHR / HRV / sleep / respiratory) in the recency window.
 * A user with no recent nightly signal cannot produce a score, so skipping
 * them keeps the pass cheap. Bounded by `cap`, newest-data first.
 */
export async function findRecoveryScoreCandidates(
  prisma: PrismaClient,
  now: Date,
  cap: number,
): Promise<string[]> {
  const since = new Date(
    now.getTime() - RECOVERY_SCORE_RECENCY_DAYS * MS_PER_DAY,
  );
  // The input-type set is a closed compile-time list of enum members —
  // splice-free; Prisma binds the `type IN (...)` array as parameters.
  //
  // Deterministic recency-under-cap: group by user, order by each user's
  // newest input first, with `userId` as the stable tiebreak so the capped
  // set is reproducible. `distinct` + `take` without an order picks an
  // arbitrary set when more than `cap` users qualify; `groupBy` makes the
  // cap take the most-recently-active users every run.
  const rows = await prisma.measurement.groupBy({
    by: ["userId"],
    where: {
      type: {
        in: [
          "RESTING_HEART_RATE",
          "HEART_RATE_VARIABILITY",
          "SLEEP_DURATION",
          "RESPIRATORY_RATE",
        ],
      },
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
 * Run one Recovery-score pass. Pure of pg-boss so the unit test drives it
 * directly. Each user is scored independently; a single user's error is
 * recorded and the pass continues (one bad account never blocks the cohort).
 */
export async function runRecoveryScore(
  prisma: PrismaClient,
  options: { now?: Date; cap?: number } = {},
): Promise<RecoveryScoreRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? RECOVERY_SCORE_BATCH_CAP;

  const userIds = await findRecoveryScoreCandidates(prisma, now, cap);

  return runScoreBatch(
    userIds,
    now,
    (userId, runNow) => persistRecoveryScore(prisma, userId, runNow),
    "insights.recovery.compute",
  );
}
