/**
 * The binding for a queue whose job can outlast pg-boss's default expiry.
 *
 * Three things together make a long job safe, and the queue table in
 * `src/__tests__/helpers/queue-runtime.ts` names every queue that needs them:
 *
 *   1. An explicit `expireInSeconds` on every send and schedule, so pg-boss
 *      does not declare the job dead at fifteen minutes while it is working.
 *   2. A time budget (`jobBudget` / `jobDeadline` in `job-budget.ts`) the
 *      handler checks between units of work, so the pass stops on its own
 *      before that expiry and the next run picks up what is left.
 *   3. A lock the running handler holds (`withJobLock`), so the retry pg-boss
 *      starts once the expiry has passed does nothing beside a run that is
 *      still going. Queue policies cannot do this: they constrain job rows,
 *      and an expired job's row is no longer active.
 *
 * `lockedPass` is the third. It wraps a handler so each job runs under the
 * lock `<queue>:<identity>`, where the identity is what two runs must not
 * share: the account for a per-user job, a constant for a pass over everyone.
 * A delivery that finds the lock held reports `already_running` and succeeds,
 * because the run that holds it is doing the work.
 */
import type { Job } from "pg-boss";

import { withJobLock } from "@/lib/jobs/job-lock";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { annotate } from "@/lib/logging/context";

/** The identity of a pass that walks every account: one run at a time. */
export const WHOLE_PASS = "pass";

export function lockedPass<J extends Job<unknown>>(
  queue: string,
  identityOf: (job: J) => string,
  handler: (jobs: J[]) => Promise<JobOutcome>,
): (jobs: J[]) => Promise<JobOutcome> {
  return async (jobs) => {
    let outcome: JobOutcome = jobDone({ jobs: 0 });
    for (const job of jobs) {
      const run = await withJobLock(`job:${queue}:${identityOf(job)}`, () =>
        handler([job]),
      );
      if (!run.ran) {
        annotate({
          action: { name: "job.long_pass.already_running" },
          meta: { queue },
        });
        outcome = jobDone({ already_running: 1 });
        continue;
      }
      // The first failed job fails the batch; pg-boss hands one job per
      // batch here, so this is that job's own outcome.
      if (!run.result.ok) return run.result;
      outcome = run.result;
    }
    return outcome;
  };
}
