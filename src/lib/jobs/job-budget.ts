/**
 * A time budget for a long pass, derived from the pg-boss job it runs under.
 *
 * pg-boss gives every job an expiry (`expireInSeconds`, 900 s unless the send
 * says otherwise). When it passes, pg-boss marks the job failed with
 * `job timed out`, retries it, and fires the job's abort signal. It does NOT
 * stop the handler: a handler that never looks at the signal keeps writing
 * after its job has been declared dead, and the retry then runs beside it over
 * the same rows. On a large account that is how one pass that could not
 * finish turned into two or three copies of itself contending for the same
 * days.
 *
 * The passes that walk a whole history therefore stop on their own, between
 * units of work, once a share of the expiry has gone by, and report that they
 * stopped early. Their units commit one at a time and a finished unit drops
 * out of the next scan, so the following run starts where this one stopped.
 * The share leaves room for the unit in flight and for the handler's own
 * bookkeeping before pg-boss's deadline.
 */
import type { Job } from "pg-boss";

/** Share of the job's expiry a pass may spend before it stops itself. */
export const JOB_BUDGET_SHARE = 0.75;

/** What the budget reads from a pg-boss job. */
type BudgetedJob = Pick<Job<unknown>, "expireInSeconds" | "signal">;

/**
 * Build the `shouldStop` predicate for a batch of jobs handled together.
 *
 * True once the budget has elapsed (the tightest job's expiry decides) or once
 * pg-boss has aborted any of the jobs. `now` is injectable for tests.
 */
export function jobBudget(
  jobs: readonly BudgetedJob[],
  now: () => number = Date.now,
): () => boolean {
  const expirySeconds = Math.min(
    ...jobs.map((job) =>
      Number.isFinite(job.expireInSeconds) && job.expireInSeconds > 0
        ? job.expireInSeconds
        : Number.POSITIVE_INFINITY,
    ),
  );
  const deadline = now() + expirySeconds * 1000 * JOB_BUDGET_SHARE;
  return () =>
    now() >= deadline || jobs.some((job) => job.signal?.aborted === true);
}
