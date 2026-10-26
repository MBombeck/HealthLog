/**
 * The queue facts of `recovery-score.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const RECOVERY_SCORE_QUEUE = "recovery-score-compute";

/**
 * Daily at 04:45 Europe/Berlin — inside the existing 03:xx–04:xx maintenance
 * window, after the cumulative drain (03:45) + the daily-mean consolidation
 * and the insight pre-generation (04:30) so the nightly signals it reads are
 * already folded into the rollup tier by the time it runs.
 */
export const RECOVERY_SCORE_CRON = "45 4 * * *";
