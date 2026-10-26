/**
 * The queue facts of `period-narrative-shared.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
export const PERIOD_NARRATIVE_QUEUE = "period-narrative-warm";

/**
 * The job's expiry: three hours. On a boundary night the scheduled pass
 * writes up to two narratives for each of 200 accounts, which can outlast
 * pg-boss's fifteen-minute default. The pass stops itself at three quarters
 * of this (`jobBudget`) and holds a lock (`lockedPass`); every send and the
 * schedule carry it.
 */
export const PERIOD_NARRATIVE_EXPIRE_SECONDS = 3 * 60 * 60;

/**
 * Nightly at 05:05 Europe/Berlin — inside the existing maintenance window,
 * after the comprehensive insight pre-generation (04:30) and the computed
 * scores (04:45–04:55) so the rollup signals it reads are already folded.
 * The handler only does real work near a week/month boundary; on every other
 * night it short-circuits cheaply.
 */
export const PERIOD_NARRATIVE_CRON = "5 5 * * *";
