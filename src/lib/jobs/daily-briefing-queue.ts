/**
 * The queue facts of `daily-briefing.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const DAILY_BRIEFING_QUEUE = "daily-briefing";

/** Every 15 minutes; the per-user local-hour gate selects the fallback slot. */
export const DAILY_BRIEFING_CRON = "*/15 * * * *";
