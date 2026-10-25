/**
 * The hourly recovery readiness evaluation: read every backup signal, judge
 * it, and push each change to the admins (`readiness-notify.ts`). The tile on
 * the admin pages reads the same verdict live; this job is what makes it a
 * push rather than a page somebody has to open.
 *
 * Cheap and bounded: a handful of indexed reads, one row per account for the
 * two backup ledgers, and at most one notice per signal per run. The next
 * tick is the retry.
 */
import type { Job } from "pg-boss";

import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { readRecoveryReadiness } from "@/lib/recovery/readiness";
import { notifyReadinessChanges } from "@/lib/recovery/readiness-notify";

export async function handleRecoveryReadiness(
  jobs: Job<object>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.recovery_readiness", async (evt) => {
    try {
      const readiness = await readRecoveryReadiness();
      const outcome = await notifyReadinessChanges(readiness);
      const counts = (state: string) =>
        readiness.signals.filter((s) => s.state === state).length;
      const did = {
        recovery_readiness_state: readiness.state,
        recovery_readiness_attention: counts("attention"),
        recovery_readiness_failing: counts("failing"),
        recovery_readiness_notices: outcome.sent.length,
        recovery_readiness_admins: outcome.admins,
      };
      for (const [key, value] of Object.entries(did)) evt.addMeta(key, value);
      return jobDone(did);
    } catch (err) {
      evt.addWarning(`recovery-readiness failed: ${err}`);
      return jobFailed("recovery readiness evaluation failed", err);
    }
  });
}
