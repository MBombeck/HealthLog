/**
 * The worker binding of the Live Activity relay pass
 * (`push-relay/live-activity.ts`): start the next dose's Activity and update
 * the running ones over the relay, for devices with the Live Activity
 * consent, while the operator's switch is on. A pass that throws fails the
 * job; the next run is the retry.
 */
import { type Job } from "pg-boss";

import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { runLiveActivityRelayPass } from "@/lib/push-relay/live-activity";

export async function handlePushLiveActivity(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.push_live_activity", async (evt) => {
    try {
      const facts = await runLiveActivityRelayPass();
      evt.addMeta("push_live_activity_started", facts.started);
      return jobDone({
        push_live_activity_devices: facts.devices,
        push_live_activity_started: facts.started,
        push_live_activity_updated: facts.updated,
      });
    } catch (err) {
      evt.addWarning(`live activity relay pass failed: ${err}`);
      return jobFailed("live activity relay pass failed", err);
    }
  });
}
