/**
 * The worker binding of the push relay's minute pass
 * (`push-relay/maintenance.ts`): register, probe, retry the outbox, rotate
 * the sender key, report receipts, prune. A pass that throws fails the job;
 * the next minute's run is the retry.
 */
import { type Job } from "pg-boss";

import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { runRelayMaintenance } from "@/lib/push-relay/maintenance";

export async function handlePushRelayMaintenance(
  jobs: Job<unknown>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.push_relay_maintenance", async (evt) => {
    try {
      const facts = await runRelayMaintenance();
      evt.addMeta("push_relay_retried", facts.retried);
      return jobDone({
        push_relay_registered: facts.registered,
        push_relay_probed: facts.probed,
        push_relay_retried: facts.retried,
        push_relay_rotated: facts.rotated,
        push_relay_receipts_sent: facts.receipts_sent,
        push_relay_pruned: facts.pruned,
        push_relay_unbound: facts.unbound,
        push_relay_instance_key_rotated: facts.instance_key_rotated,
      });
    } catch (err) {
      evt.addWarning(`push-relay maintenance failed: ${err}`);
      return jobFailed("push-relay maintenance failed", err);
    }
  });
}
