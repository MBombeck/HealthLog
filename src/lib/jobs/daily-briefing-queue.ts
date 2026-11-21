/**
 * The queue facts of `daily-briefing.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const DAILY_BRIEFING_QUEUE = "daily-briefing";

/**
 * Every 15 minutes, eight minutes past each quarter hour so it does not start
 * beside the reminder checks; the per-user local-hour gate selects the
 * fallback slot, so the minute inside the hour does not matter.
 */
export const DAILY_BRIEFING_CRON = "8-59/15 * * * *";
