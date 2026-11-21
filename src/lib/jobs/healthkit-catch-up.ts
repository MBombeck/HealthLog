/**
 * The worker binding of the hourly HealthKit catch-up pass
 * (`push-relay/healthkit-catch-up.ts`): ask every iOS device whose Apple
 * Health upload fell behind for a pass, within its limits. A pass that throws
 * fails the job; the next hour's run is the retry.
 */
import { type Job } from "pg-boss";

import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { runHealthKitCatchUp } from "@/lib/push-relay/healthkit-catch-up";

export async function handleHealthKitCatchUp(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.healthkit_catch_up", async (evt) => {
    try {
      const facts = await runHealthKitCatchUp();
      evt.addMeta("healthkit_catch_up_sent", facts.sent);
      return jobDone({
        healthkit_catch_up_candidates: facts.candidates,
        healthkit_catch_up_sent: facts.sent,
        healthkit_catch_up_limited: facts.limited,
      });
    } catch (err) {
      evt.addWarning(`healthkit catch-up pass failed: ${err}`);
      return jobFailed("healthkit catch-up pass failed", err);
    }
  });
}
