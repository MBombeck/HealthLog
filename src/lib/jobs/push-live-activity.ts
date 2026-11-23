/**
 * The worker binding of the five-minute Live Activity pass.
 *
 * First the ends the relay did not take
 * (`notifications/live-activity-answered.ts`): each is sent again until it
 * arrived, whether or not the operator's relay switch for starts and updates
 * is on. Then the relay pass
 * (`push-relay/live-activity.ts`): start the next dose's Activity and update
 * the running ones over the relay, for devices with the Live Activity
 * consent, while that switch is on.
 *
 * A pass that throws fails the job; the next run is the retry. A device that
 * throws is counted and the pass carries on.
 */
import { type Job } from "pg-boss";

import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { retryLostActivityEnds } from "@/lib/notifications/live-activity-answered";
import { runLiveActivityRelayPass } from "@/lib/push-relay/live-activity";

export async function handlePushLiveActivity(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.push_live_activity", async (evt) => {
    try {
      const ends = await retryLostActivityEnds();
      const facts = await runLiveActivityRelayPass();
      evt.addMeta("push_live_activity_started", facts.started);
      evt.addMeta("push_live_activity_ended", ends.ended);
      const failed = facts.failed + ends.failed;
      return jobDone({
        push_live_activity_devices: facts.devices,
        push_live_activity_started: facts.started,
        push_live_activity_updated: facts.updated,
        push_live_activity_ended: ends.ended,
        // Every device the relay pass reached and every lost end was attempted.
        items_attempted: facts.devices + ends.retried,
        items_failed: failed,
        partial_failed: failed > 0,
      });
    } catch (err) {
      evt.addWarning(`live activity pass failed: ${err}`);
      return jobFailed("live activity pass failed", err);
    }
  });
}
