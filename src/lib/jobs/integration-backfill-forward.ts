/**
 * The handler of every full-history source queue (`whoop-backfill`,
 * `strava-backfill`, the sleep repairs, ...): it forwards each job to the
 * shared admission queue, where the import itself runs in the one
 * cross-provider lane. The source queue keeps its per-connection singleton
 * key, which is what boot discovery re-offers against.
 */
import type { Job, PgBoss } from "pg-boss";

import {
  enqueueIntegrationBackfillAdmission,
  type IntegrationBackfillData,
  type IntegrationBackfillKind,
} from "@/lib/jobs/integration-backfill-admission";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";

export function forwardToBackfillAdmission(
  boss: PgBoss,
  kind: IntegrationBackfillKind,
): (jobs: Job<IntegrationBackfillData>[]) => Promise<JobOutcome> {
  return async (jobs) => {
    for (const job of jobs) {
      await enqueueIntegrationBackfillAdmission(boss, { kind, data: job.data });
    }
    return jobDone({ jobs: jobs.length });
  };
}
