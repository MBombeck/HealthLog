/**
 * Nightly refresh of the `CyclePrediction` forecast rows.
 *
 * The cycle-reminder cron scans `CyclePrediction` to decide who is due a
 * period-soon or fertile-soon push. Until v1.35.3 those rows were written
 * only as a side effect of `GET /api/cycle/calendar`, so an account that
 * tracked its cycle but never opened the calendar page was scanned against a
 * forecast made from whatever its data looked like the last time somebody
 * looked — or was never scanned at all. Moving the write here makes the
 * reminder's input a function of the account's data instead of its browsing.
 *
 * Cohort: accounts that hold a `CycleProfile` with prediction not explicitly
 * off, resolved through the same two-layer cycle gate the routes use, so an
 * operator-disabled module refreshes nothing. Per-account failures are
 * counted and the pass continues; a pass that failed for every account it
 * touched fails the job so the operator sees it.
 *
 * Runs at 04:20 Europe/Berlin, after the 03:xx retention block. The forecast
 * moves on a day scale and the reminder windows are days wide, so a fixed
 * server-side hour is close enough for every timezone the cohort spans.
 */
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import type { Job } from "pg-boss";

import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import { refreshPredictionCacheForUser } from "@/lib/cycle/prediction-refresh";
import { getWorkerPrisma } from "./reminder/shared";

export const CYCLE_PREDICTION_REFRESH_QUEUE = "cycle-prediction-refresh";

export const CYCLE_PREDICTION_REFRESH_CRON = "20 4 * * *";

export interface CyclePredictionRefreshPayload {
  triggeredAt: string;
}

export interface CyclePredictionRefreshSummary {
  /** Profiles the cohort query returned. */
  scanned: number;
  /** Accounts whose forecast row now reflects their data. */
  refreshed: number;
  /** Accounts skipped: module off, prediction off, or raw-chart mode. */
  skipped: number;
  /** Accounts whose refresh threw. */
  failed: number;
}

/**
 * Refresh every eligible account's forecast. Exported for the test; the
 * handler below is the queue binding.
 */
export async function runCyclePredictionRefresh(
  now: Date = new Date(),
  options: {
    isAvailable?: typeof isCycleAvailableForUser;
    refresh?: typeof refreshPredictionCacheForUser;
  } = {},
): Promise<CyclePredictionRefreshSummary> {
  const isAvailable = options.isAvailable ?? isCycleAvailableForUser;
  const refresh = options.refresh ?? refreshPredictionCacheForUser;
  const prisma = getWorkerPrisma();

  const profiles = await prisma.cycleProfile.findMany({
    where: { NOT: { predictionEnabled: false }, ...OWNED_BY_ACTIVE_ACCOUNT },
    select: { userId: true },
  });

  const summary: CyclePredictionRefreshSummary = {
    scanned: profiles.length,
    refreshed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const { userId } of profiles) {
    try {
      if (!(await isAvailable(userId))) {
        summary.skipped += 1;
        continue;
      }
      const outcome = await refresh(userId, now);
      if (outcome === "persisted") summary.refreshed += 1;
      else summary.skipped += 1;
    } catch {
      // One account's bad data must not cost every other account its
      // reminders. The count is what makes a systemic failure visible.
      summary.failed += 1;
    }
  }

  return summary;
}

export async function handleCyclePredictionRefresh(
  jobs: Job<CyclePredictionRefreshPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.cycle_prediction_refresh", async (evt) => {
    const summary = await runCyclePredictionRefresh();
    evt.addMeta("cycle_prediction_scanned", summary.scanned);
    evt.addMeta("cycle_prediction_refreshed", summary.refreshed);
    evt.addMeta("cycle_prediction_skipped", summary.skipped);
    evt.addMeta("cycle_prediction_failed", summary.failed);

    // Every account failing is a systemic fault (a dead pool, a schema drift),
    // not one account's bad data. Anything short of that stays a success with
    // the count on the event.
    if (summary.failed > 0 && summary.failed === summary.scanned) {
      return jobFailed(
        `cycle-prediction-refresh failed for all ${summary.failed} accounts`,
      );
    }
    return jobDone({
      users_scanned: summary.scanned,
      refreshed: summary.refreshed,
      skipped: summary.skipped,
      users_failed: summary.failed,
    });
  });
}
