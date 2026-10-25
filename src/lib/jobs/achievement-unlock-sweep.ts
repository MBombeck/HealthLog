/**
 * Nightly sweep that pins newly unlocked achievements.
 *
 * An unlock date is derived from the account's own history, so the badge
 * grid renders correctly whether or not a `UserAchievement` row exists — the
 * row is what makes the DATE durable once the underlying rows move, and it
 * is what the backup carries ("the date is the part that cannot be
 * recovered").
 *
 * Until v1.35.3 the only thing that wrote those rows was
 * `GET /api/gamification/achievements`. That made a durable record a side
 * effect of somebody looking at a page: an account that earned a badge and
 * never opened the app pinned nothing, and a read carried an INSERT that an
 * MCP-audience read token would have been admitted on the moment any route
 * declared a narrow scope. The evaluation is unchanged and still runs on the
 * read; only the persistence moved here, where it covers every account
 * rather than the ones that happened to look.
 *
 * The date written is the computed completion date, not the sweep's own
 * clock, so a badge pinned tonight and the same badge pinned a week from now
 * carry the identical timestamp. Running late costs nothing but exposure to
 * a data edit in between.
 *
 * Runs at 04:25 Europe/Berlin, after the cycle-prediction refresh (04:20).
 */
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { Job } from "pg-boss";

import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { resolveModuleMap } from "@/lib/modules/gate";
import { buildAchievementsResult } from "@/lib/gamification/achievements-result";
import { getWorkerPrisma } from "./reminder/shared";

export interface AchievementUnlockSweepPayload {
  triggeredAt: string;
}

export interface AchievementUnlockSweepSummary {
  /** Accounts the sweep looked at. */
  scanned: number;
  /** Accounts with the achievements module off. */
  skipped: number;
  /** Unlock rows written across every account. */
  persisted: number;
  /** Accounts whose evaluation or write threw. */
  failed: number;
}

/**
 * Pin every unpinned unlock across all accounts. Exported for the test; the
 * handler below is the queue binding.
 */
export async function runAchievementUnlockSweep(
  options: {
    resolveModules?: typeof resolveModuleMap;
    buildResult?: typeof buildAchievementsResult;
  } = {},
): Promise<AchievementUnlockSweepSummary> {
  const resolveModules = options.resolveModules ?? resolveModuleMap;
  const buildResult = options.buildResult ?? buildAchievementsResult;
  const prisma = getWorkerPrisma();

  const users = await prisma.user.findMany({
    where: ACTIVE_ACCOUNT,
    orderBy: { id: "asc" },
  });

  const summary: AchievementUnlockSweepSummary = {
    scanned: users.length,
    skipped: 0,
    persisted: 0,
    failed: 0,
  };

  for (const user of users) {
    try {
      const moduleMap = await resolveModules(user.id);
      // Same gate the route applies: an account with the module off gets no
      // badge evaluation and no unlock persistence.
      if (moduleMap.achievements === false) {
        summary.skipped += 1;
        continue;
      }

      const result = await buildResult(user, moduleMap);
      if (result.pendingUnlocks.length === 0) continue;

      // Idempotent on the `(userId, achievementId)` unique, so a re-run
      // against an already-pinned badge is a no-op rather than a duplicate.
      const written = await prisma.userAchievement.createMany({
        data: result.pendingUnlocks.map((u) => ({
          userId: user.id,
          achievementId: u.achievementId,
          unlockedAt: new Date(u.unlockedAt),
        })),
        skipDuplicates: true,
      });
      summary.persisted += written.count;
    } catch {
      // One account's evaluation must not cost every other account its
      // pinned dates. The count is what makes a systemic failure visible.
      summary.failed += 1;
    }
  }

  return summary;
}

export async function handleAchievementUnlockSweep(
  jobs: Job<AchievementUnlockSweepPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.achievement_unlock_sweep", async (evt) => {
    const summary = await runAchievementUnlockSweep();
    evt.addMeta("achievement_sweep_scanned", summary.scanned);
    evt.addMeta("achievement_sweep_skipped", summary.skipped);
    evt.addMeta("achievement_sweep_persisted", summary.persisted);
    evt.addMeta("achievement_sweep_failed", summary.failed);

    // Every account failing is a systemic fault, not one account's data.
    if (summary.failed > 0 && summary.failed === summary.scanned) {
      return jobFailed(
        `achievement-unlock-sweep failed for all ${summary.failed} accounts`,
      );
    }
    return jobDone({
      users_scanned: summary.scanned,
      skipped: summary.skipped,
      persisted: summary.persisted,
      users_failed: summary.failed,
    });
  });
}
