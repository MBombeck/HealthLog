/**
 * The worker binding of the DATA_CHANGED minute pass
 * (`push-relay/data-changed.ts`): send every pending wake whose five-minute
 * window has closed, then prune the wake ledger. A pass that throws fails
 * the job; the next minute's run is the retry.
 */
import { type Job } from "pg-boss";

import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { flushDueDataChanges } from "@/lib/push-relay/data-changed";

export async function handlePushDataChanged(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.push_data_changed", async (evt) => {
    try {
      const facts = await flushDueDataChanges();
      evt.addMeta("push_data_changed_flushed", facts.flushed);
      return jobDone({
        push_data_changed_flushed: facts.flushed,
        push_wakes_pruned: facts.pruned,
      });
    } catch (err) {
      evt.addWarning(`push data-changed pass failed: ${err}`);
      return jobFailed("push data-changed pass failed", err);
    }
  });
}
