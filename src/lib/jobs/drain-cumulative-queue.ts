/**
 * The nightly drain of per-sample cumulative rows: its queue, cron and
 * payload. It collapses each user × cumulative type × day into one `stats:`
 * row, and the same tick folds the daily-mean and dense intra-day retention
 * passes (`reminder/rollup-handlers.ts`). 03:45 sits between the 03:15
 * audit-log cleanup and the 04:00 feedback aggregator; the 36-hour grace
 * window keeps today and the trailing watch-sync window raw.
 */
export const DRAIN_CUMULATIVE_QUEUE = "drain-per-sample-cumulative";

export const DRAIN_CUMULATIVE_CRON = "45 3 * * *";

export interface DrainCumulativePayload {
  triggeredAt?: string;
  /**
   * How many times this tick has already handed itself on. Absent on the
   * cron's own job. See `nextDrainContinuation`.
   */
  continuation?: number;
}
