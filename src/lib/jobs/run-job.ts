/**
 * The wrapper that turns a returned `JobOutcome` into a pg-boss result.
 *
 * `boss.work(queue, opts, handler)` completes a job when the handler's
 * promise resolves, whatever it resolves to. Wrapping every handler in
 * `runJob` moves that decision from "the function returned" to "the function
 * said it succeeded": an `ok: false` outcome is reported and rethrown, so
 * pg-boss records a failed job, the queue's retry policy applies, and the
 * failed-job readers in `job-failures.ts` surface it to the operator.
 *
 * This changes runtime behaviour, not only visibility. Handlers that used to
 * catch, warn and return now fail their job. For a queue whose failure mode
 * is deterministic — a DELETE that times out will time out again — retrying
 * is wasted load, so the retry policy of every converted queue has to be a
 * decision rather than a default.
 *
 * The wrapper deliberately does not open a wide event of its own. Handlers
 * own their `withBackgroundEvent` scope and annotate inside it; a second
 * event here would double every worker line for no added fact.
 */
import type { Job, JobWithMetadata } from "pg-boss";

import {
  serializeJobOutcome,
  type JobFact,
  type JobFacts,
  type JobOutcome,
  type SerializedJobOutcome,
} from "./job-outcome";
import { reportWorkerError } from "./report-worker-error";
import { observeJob } from "./job-observer";
import { readConsecutiveRunFailures } from "./job-failures";
import { emitSignal } from "@/lib/logging/signal";

/** A converted handler: it says what it did instead of just finishing. */
export type JobHandler<T> = (jobs: Job<T>[]) => Promise<JobOutcome>;

/** The same, for a queue bound with `includeMetadata: true`. */
export type JobWithMetadataHandler<T> = (
  jobs: JobWithMetadata<T>[],
) => Promise<JobOutcome>;

/**
 * The error a failed outcome becomes. Carries the queue and the handler's
 * own reason so the pg-boss `output` column, the GlitchTip event and the
 * container log all name the same thing.
 */
export class JobFailure extends Error {
  readonly queue: string;
  readonly reason: string;

  constructor(queue: string, reason: string, cause?: unknown) {
    super(`${queue}: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "JobFailure";
    this.queue = queue;
    this.reason = reason;
    // Carry the thrown error's stack. Without this the only stack the
    // operator ever sees points at `runJob`, which is the same for all 101
    // queues and says nothing about where the work actually broke.
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.name}: ${this.message}\ncaused by ${cause.stack}`;
    }
  }
}

function factMeta(did: JobFacts | undefined): Record<string, JobFact> {
  const meta: Record<string, JobFact> = {};
  for (const [key, value] of Object.entries(did ?? {})) meta[key] = value;
  return meta;
}

/**
 * The failed run's own line: `job.run.failed` at `error`, naming the queue and
 * how many runs of it in a row have now failed. Every queue reaches it, so
 * the repeated-failure alert keys on one action and one number instead of on
 * the handler's own task name, which differs per queue, or on the stderr line
 * `reportWorkerError` writes, which is not structured.
 */
async function signalRunFailed(
  queue: string,
  reason: string,
  error: unknown,
): Promise<void> {
  const consecutiveFailures = await readConsecutiveRunFailures(queue);
  emitSignal({
    action: "job.run.failed",
    level: "error",
    meta: { queue, reason, consecutiveFailures },
    error,
  });
}

/**
 * Wrap a handler for `boss.work`. Resolves with the bounded, redacted
 * persistence representation on `ok: true`; reports and rethrows on
 * `ok: false`.
 *
 * A handler that throws keeps its own error — re-wrapping it would only bury
 * the original stack — but its run still gets the `job.run.failed` line.
 */
export function runJob<J>(
  queue: string,
  handler: (jobs: J[]) => Promise<JobOutcome>,
): (jobs: J[]) => Promise<SerializedJobOutcome> {
  return async (jobs: J[]): Promise<SerializedJobOutcome> => {
    // Observed, so a long run, an expiry and a cut-off leave a line in the
    // log naming the queue and how far it got (see `job-observer.ts`).
    let outcome: JobOutcome;
    try {
      outcome = await observeJob(
        queue,
        jobs as ReadonlyArray<{ id?: string; expireInSeconds?: number }>,
        () => handler(jobs),
      );
    } catch (error) {
      await signalRunFailed(queue, "handler_threw", error);
      throw error;
    }
    if (outcome.ok) return serializeJobOutcome(outcome);

    const failure = new JobFailure(queue, outcome.reason, outcome.cause);
    const causeMessage =
      outcome.cause instanceof Error
        ? outcome.cause.message
        : typeof outcome.cause === "string"
          ? outcome.cause
          : undefined;

    await reportWorkerError(queue, failure, {
      ...factMeta(outcome.did),
      ...(causeMessage === undefined ? {} : { cause: causeMessage }),
    });
    await signalRunFailed(queue, outcome.reason, failure);

    throw failure;
  };
}
