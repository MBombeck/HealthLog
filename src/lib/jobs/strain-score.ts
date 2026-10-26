/**
 * v1.10.0 — computed scores (WX-E). Nightly Strain-score computation + store.
 *
 * Once a night this cron computes each eligible user's Strain score from
 * the day's per-workout heart-rate series (`WorkoutSamples`, WX-D) plus
 * active-energy burned, via Banister's TRIMP cardio-load model (see
 * `src/lib/insights/strain-score.ts`), and persists it as a `COMPUTED
 * STRAIN_SCORE` Measurement row. The score is never computed on a page
 * visit.
 *
 * Idempotent per user per day: the per-user persist upserts on
 * `(userId, type, source, externalId)` with `externalId = strain:YYYY-MM-DD`,
 * so a re-fired cron tick (or a manual re-run) overwrites the day's row in
 * place. A user with no usable cardio-load input that day gets NO row.
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` so pg-boss provisions it at boot; an
 * unregistered queue silently never drains.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { persistStrainScore } from "@/lib/insights/strain-score";
import { runScoreBatch } from "@/lib/insights/score-row";
import { excludePendingOwners } from "@/lib/account-deletion/active-account";

/** Per-run user cap — same starvation guard the other score passes use. */
export const STRAIN_SCORE_BATCH_CAP = 500;

/** Trailing window (days) a user must have a recent strain-input row in. */
export const STRAIN_SCORE_RECENCY_DAYS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StrainScoreRunResult {
  considered: number;
  stored: number;
  insufficient: number;
  errored: number;
}

/**
 * Discover users worth scoring tonight: anyone with a workout started in the
 * recency window OR an `ACTIVE_ENERGY_BURNED` row in it. A user with neither
 * cannot produce a Strain score, so skipping them keeps the pass cheap.
 * Bounded by `cap`.
 */
export async function findStrainScoreCandidates(
  prisma: PrismaClient,
  now: Date,
  cap: number,
): Promise<string[]> {
  const since = new Date(
    now.getTime() - STRAIN_SCORE_RECENCY_DAYS * MS_PER_DAY,
  );
  // Deterministic recency-under-cap on both source queries: group by user,
  // newest activity first, `userId` tiebreak. `distinct` + `take` without an
  // order picked an arbitrary set when more than `cap` users qualified; the
  // ordered `groupBy` makes each side take the most-recently-active users, and
  // the merge below is order-stable.
  // An account pending deletion gets no score and takes no slot of the cap.
  const [workoutUsers, energyUsers] = await Promise.all([
    prisma.workout.groupBy({
      by: ["userId"],
      where: {
        startedAt: { gte: since },
        ...(await excludePendingOwners(prisma)),
      },
      orderBy: [{ _max: { startedAt: "desc" } }, { userId: "asc" }],
      take: cap,
    }),
    prisma.measurement.groupBy({
      by: ["userId"],
      where: {
        type: "ACTIVE_ENERGY_BURNED",
        deletedAt: null,
        measuredAt: { gte: since },
        ...(await excludePendingOwners(prisma)),
      },
      orderBy: [{ _max: { measuredAt: "desc" } }, { userId: "asc" }],
      take: cap,
    }),
  ]);
  // Interleave the two recency-ordered lists so the merged cap favours the
  // most-recently-active users across both sources rather than draining one
  // list first. Both inputs are already deterministic, so the merge is too.
  const ids = new Set<string>();
  const maxLen = Math.max(workoutUsers.length, energyUsers.length);
  for (let i = 0; i < maxLen && ids.size < cap; i++) {
    if (i < workoutUsers.length) ids.add(workoutUsers[i].userId);
    if (ids.size < cap && i < energyUsers.length)
      ids.add(energyUsers[i].userId);
  }
  return Array.from(ids).slice(0, cap);
}

/**
 * Run one Strain-score pass. Pure of pg-boss so the unit test drives it
 * directly. Each user is scored independently; a single user's error is
 * recorded and the pass continues.
 */
export async function runStrainScore(
  prisma: PrismaClient,
  options: { now?: Date; cap?: number } = {},
): Promise<StrainScoreRunResult> {
  const now = options.now ?? new Date();
  const cap = options.cap ?? STRAIN_SCORE_BATCH_CAP;

  const userIds = await findStrainScoreCandidates(prisma, now, cap);

  return runScoreBatch(
    userIds,
    now,
    (userId, runNow) => persistStrainScore(prisma, userId, runNow),
    "insights.strain.compute",
  );
}
