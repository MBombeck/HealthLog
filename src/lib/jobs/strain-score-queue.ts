/**
 * The queue facts of `strain-score.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const STRAIN_SCORE_QUEUE = "strain-score-compute";

/**
 * Daily at 04:55 Europe/Berlin — inside the existing maintenance window,
 * after the recovery-score (04:45) + stress-score (04:50) passes so the
 * nightly score writes stay ordered and don't pile on one boss poll.
 */
export const STRAIN_SCORE_CRON = "55 4 * * *";
