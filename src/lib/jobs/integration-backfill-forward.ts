/**
 * The handler of every full-history source queue (`whoop-backfill`,
 * `strava-backfill`, the sleep repairs, ...): it forwards each job to the
 * shared admission queue, where the import itself runs in the one
 * cross-provider lane. The source queue keeps its per-connection singleton
 * key, which is what boot discovery re-offers against.
 *
 * The forward is a fresh offer of the import, so it goes out only when no
 * other job of the import waits (`integration-backfill-claim.ts`): a retry
 * waiting out a provider outage, or a follow-up slice, carries the import
 * on from its progress note already.
 */
import type { Job, PgBoss } from "pg-boss";

import type {
  IntegrationBackfillData,
  IntegrationBackfillKind,
} from "@/lib/jobs/integration-backfill-admission";
import { sendBackfillUnlessWaiting } from "@/lib/jobs/integration-backfill-claim";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";

export function forwardToBackfillAdmission(
  boss: PgBoss,
  kind: IntegrationBackfillKind,
): (jobs: Job<IntegrationBackfillData>[]) => Promise<JobOutcome> {
  return async (jobs) => {
    let alreadyWaiting = 0;
    for (const job of jobs) {
      const result = await sendBackfillUnlessWaiting(boss, {
        kind,
        data: job.data,
      });
      if (result.kind === "waiting") alreadyWaiting += 1;
    }
    return jobDone({ jobs: jobs.length, already_waiting: alreadyWaiting });
  };
}
