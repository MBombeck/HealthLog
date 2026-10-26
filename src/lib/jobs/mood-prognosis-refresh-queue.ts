/**
 * The queue facts of `mood-prognosis-refresh.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const MOOD_PROGNOSIS_REFRESH_QUEUE = "mood-prognosis-refresh";

export const MOOD_PROGNOSIS_REFRESH_CRON = "35 4 * * *";
