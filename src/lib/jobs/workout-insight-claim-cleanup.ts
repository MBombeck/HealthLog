/**
 * Daily retention for `workout_insight_generation_claims`.
 *
 * The claim row is the ledger behind the per-workout insight daily cap, and it
 * outlives its workout on purpose: deleting a workout nulls the claim's
 * `workout_id` instead of removing the row, so the delete cannot free the
 * day's slot. The cap only ever reads today's rows, so anything older than the
 * retention window is dead weight and is dropped here.
 *
 * Keyed on `updated_at`, which moves on every claim, reclaim, provider
 * invocation and completion. A row written within the window is kept whatever
 * its `local_date` says, so no row that the cap can still read is ever
 * deleted.
 */
// account-deletion(file): expires generation claims; acts for no account.
import type { PrismaClient } from "@/generated/prisma/client";

export const WORKOUT_INSIGHT_CLAIM_RETENTION_DAYS = 7;

export async function cleanupOldWorkoutInsightClaims(
  prisma: Pick<PrismaClient, "workoutInsightGenerationClaim">,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - WORKOUT_INSIGHT_CLAIM_RETENTION_DAYS * 86_400_000,
  );
  const { count } = await prisma.workoutInsightGenerationClaim.deleteMany({
    where: { updatedAt: { lt: cutoff } },
  });
  return count;
}
