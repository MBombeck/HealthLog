/**
 * Five-minute reaper for background document AI runs (v1.40).
 *
 * A run carries its next deadline in `expiresAt`, and this pass acts on it:
 * a run no worker picked up within fifteen minutes fails as
 * `aiRuns.workerUnavailable` (its reservation handed back), a run past the
 * time its model calls were allowed fails as `aiRuns.timedOut`, and a run
 * that finished an hour ago is deleted with its sealed result. Every step is
 * a conditional write on the state it leaves, so a tick that overlaps a
 * worker, or a second tick, changes nothing twice. The next tick is the retry.
 */
import { type Job } from "pg-boss";

import { reapAiRuns } from "@/lib/documents/ai-runs/store";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";

export interface DocumentAiRunReaperPayload {
  triggeredAt?: string;
}

export async function handleDocumentAiRunReaper(
  jobs: Job<DocumentAiRunReaperPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.document_ai_run_reaper", async (evt) => {
    try {
      const summary = await reapAiRuns();
      evt.setAction({ name: "ai_runs.reap" });
      evt.addMeta("ai_runs_worker_unavailable", summary.workerUnavailable);
      evt.addMeta("ai_runs_timed_out", summary.timedOut);
      evt.addMeta("ai_runs_deleted", summary.deleted);
      return jobDone({
        ai_runs_worker_unavailable: summary.workerUnavailable,
        ai_runs_timed_out: summary.timedOut,
        ai_runs_deleted: summary.deleted,
      });
    } catch (err) {
      evt.addWarning(`document-ai-run-reaper failed: ${err}`);
      return jobFailed("document ai run reaper failed", err);
    }
  });
}
