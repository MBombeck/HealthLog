/**
 * The queue facts of `achievement-unlock-sweep.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const ACHIEVEMENT_UNLOCK_SWEEP_QUEUE = "achievement-unlock-sweep";

export const ACHIEVEMENT_UNLOCK_SWEEP_CRON = "25 4 * * *";
