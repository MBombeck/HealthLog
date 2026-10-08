/**
 * One report per job run with one outcome per candidate (v1.42).
 *
 * A pass over many accounts used to annotate its wide event once per
 * candidate, and the last write won: a run where six accounts worked and one
 * failed read as whatever the last account did. `reportJobRun` takes the
 * whole candidate list instead, so the run's line carries every outcome and
 * the level follows the worst of them.
 *
 * Contract stub: the signature is fixed for its callers (the insight
 * pre-generation, the tombstone purge, the measurement maintenance). Until
 * the implementation lands it annotates the run's counts the way the callers
 * do today.
 */
import { annotate } from "@/lib/logging/context";

/** How one candidate of a run ended. */
export type JobRunOutcome =
  "ok" | "skipped" | "deferred" | "auth_failed" | "screened" | "failed";

export interface JobRunCandidate {
  /** Stable, non-identifying key (a scope or a hashed id, never a user id). */
  key: string;
  outcome: JobRunOutcome;
  /** Short, stable cause for a non-`ok` outcome. */
  cause?: string;
}

export function reportJobRun(input: {
  queue: string;
  runId: string;
  candidates: readonly JobRunCandidate[];
}): void {
  const failed = input.candidates.filter(
    (c) => c.outcome === "failed" || c.outcome === "auth_failed",
  ).length;
  annotate({
    meta: {
      queue: input.queue,
      runId: input.runId,
      candidates: input.candidates.length,
      failed,
    },
  });
}
