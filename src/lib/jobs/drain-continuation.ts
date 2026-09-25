/**
 * When the nightly drain tick hands its remaining work to a follow-up job.
 *
 * The tick's three passes (cumulative drain, daily-mean consolidation, dense
 * intra-day retention) stop at the job's time budget (`jobBudget`) instead of
 * running into pg-boss's expiry. On a normal night that never happens. After
 * a multi-year import it does, and without a follow-up the backlog would drain
 * one budget per night. So a tick that stopped early sends itself again a
 * minute later, and the chain is bounded twice: a follow-up is sent only when
 * the run folded at least one day, so a pass that makes no progress cannot
 * loop, and never more than `DRAIN_MAX_CONTINUATIONS` times in a row.
 */

/** Follow-ups one nightly tick may chain: about four and a half hours of budget. */
export const DRAIN_MAX_CONTINUATIONS = 24;

/** Delay before a follow-up tick starts, in seconds. */
export const DRAIN_CONTINUATION_DELAY_SECONDS = 60;

/**
 * The follow-up's continuation number, or `null` when no follow-up is due.
 * `continuation` is the current job's own number (0 for the cron's job).
 */
export function nextDrainContinuation(input: {
  stoppedEarly: boolean;
  daysFolded: number;
  continuation: number;
}): number | null {
  if (!input.stoppedEarly) return null;
  if (input.daysFolded <= 0) return null;
  if (input.continuation >= DRAIN_MAX_CONTINUATIONS) return null;
  return input.continuation + 1;
}
