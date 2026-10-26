/**
 * The queue facts of `stress-score.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const STRESS_SCORE_QUEUE = "stress-score-compute";

/**
 * Daily at 04:50 Europe/Berlin — inside the existing maintenance window,
 * after the dense intra-day retention drain (03:50) and the recovery-score
 * pass (04:45) so the HRV inputs it reads are settled.
 */
export const STRESS_SCORE_CRON = "50 4 * * *";
