/**
 * One report per job run with one outcome per candidate (v1.42).
 *
 * A pass over many accounts used to annotate its wide event once per
 * candidate, and the last write won: a run where six accounts worked and one
 * failed read as whatever the last account did. The nightly briefing warm read
 * as `all-failed` on seven nights in a row when it had in fact completed every
 * night, because the last account of each run happened to fail. `reportJobRun`
 * takes the whole candidate list instead, so the run's line carries every
 * outcome and the level follows the run as a whole:
 *
 *   - every attempted candidate failed → `job.run.failed` at `error`, with how
 *     many runs of the queue in a row have now failed (`consecutiveFailures`,
 *     the number the repeated-failure alert keys on);
 *   - some failed, or a result was withheld → `job.run.partial` at `warn`;
 *   - otherwise nothing extra: the run's own line says what it did.
 *
 * "Attempted" leaves out `skipped` and `deferred` candidates: an account
 * without consent or one the job budget did not reach is not a failure of the
 * run. `screened` (the model answered and the safety screen withheld it) is
 * attempted but is not a provider failure, so a run of only screened
 * candidates is partial, not failed.
 *
 * The verdict comes back to the caller, which writes `all_failed` into its
 * `jobDone` facts. That fact is what lets `readConsecutiveRunFailures` count a
 * completed-but-all-failed night as part of a streak.
 */
import { annotate } from "@/lib/logging/context";
import { emitSignal } from "@/lib/logging/signal";
import { readConsecutiveRunFailures } from "@/lib/jobs/job-failures";

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

export interface JobRunVerdict {
  /** Candidates the run looked at. */
  total: number;
  /** Candidates it actually attempted (not skipped, not deferred). */
  attempted: number;
  /** `failed` + `auth_failed`. */
  failed: number;
  /** Every attempted candidate failed (and at least one was attempted). */
  allFailed: boolean;
  /** Something failed or was withheld, but not everything. */
  partial: boolean;
}

/** Candidates listed on the run's line; the counts always cover all of them. */
const MAX_LISTED_CANDIDATES = 50;

const FAILED: ReadonlySet<JobRunOutcome> = new Set(["failed", "auth_failed"]);
const NOT_ATTEMPTED: ReadonlySet<JobRunOutcome> = new Set([
  "skipped",
  "deferred",
]);

/** The verdict alone, without logging. Pure, for callers and tests. */
export function judgeJobRun(
  candidates: readonly JobRunCandidate[],
): JobRunVerdict {
  const total = candidates.length;
  const attempted = candidates.filter(
    (c) => !NOT_ATTEMPTED.has(c.outcome),
  ).length;
  const failed = candidates.filter((c) => FAILED.has(c.outcome)).length;
  const screened = candidates.filter((c) => c.outcome === "screened").length;
  const allFailed = attempted > 0 && failed === attempted;
  return {
    total,
    attempted,
    failed,
    allFailed,
    partial: !allFailed && (failed > 0 || screened > 0),
  };
}

export async function reportJobRun(input: {
  queue: string;
  runId: string;
  candidates: readonly JobRunCandidate[];
}): Promise<JobRunVerdict> {
  const verdict = judgeJobRun(input.candidates);
  const byOutcome: Record<string, number> = {};
  for (const c of input.candidates) {
    byOutcome[c.outcome] = (byOutcome[c.outcome] ?? 0) + 1;
  }

  annotate({
    meta: {
      queue: input.queue,
      runId: input.runId,
      candidates: verdict.total,
      attempted: verdict.attempted,
      failed: verdict.failed,
      all_failed: verdict.allFailed,
      outcomes: byOutcome,
      candidate_outcomes: input.candidates
        .slice(0, MAX_LISTED_CANDIDATES)
        .map((c) => ({
          key: c.key,
          outcome: c.outcome,
          ...(c.cause ? { cause: c.cause } : {}),
        })),
    },
  });

  if (verdict.allFailed) {
    const consecutiveFailures = await readConsecutiveRunFailures(input.queue);
    emitSignal({
      action: "job.run.failed",
      level: "error",
      meta: {
        queue: input.queue,
        runId: input.runId,
        consecutiveFailures,
        failed: verdict.failed,
        total: verdict.attempted,
        causes: distinctCauses(input.candidates),
      },
    });
  } else if (verdict.partial) {
    emitSignal({
      action: "job.run.partial",
      level: "warn",
      meta: {
        queue: input.queue,
        runId: input.runId,
        failed: verdict.failed,
        total: verdict.attempted,
        outcomes: byOutcome,
        causes: distinctCauses(input.candidates),
      },
    });
  }
  return verdict;
}

/** The distinct causes of the run's failed or withheld candidates, bounded. */
function distinctCauses(candidates: readonly JobRunCandidate[]): string[] {
  const causes = new Set<string>();
  for (const c of candidates) {
    if (c.outcome === "ok" || NOT_ATTEMPTED.has(c.outcome) || !c.cause) {
      continue;
    }
    causes.add(`${c.outcome}:${c.cause}`);
    if (causes.size >= 10) break;
  }
  return [...causes];
}
