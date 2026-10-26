/**
 * The queue facts of `integration-watchdog.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const INTEGRATION_WATCHDOG_HOURLY_QUEUE = "integration-watchdog-hourly";

export const INTEGRATION_WATCHDOG_DAILY_QUEUE = "integration-watchdog-daily";

/**
 * :47 is a free minute off every hourly sync tick (used: 0, 5, 8, 11, 13, 15,
 * 17, 18, 20, 30, 35, 41, 50), late enough in the hour that the syncs before it
 * have written what they fetched.
 */
export const INTEGRATION_WATCHDOG_HOURLY_CRON = "47 * * * *";

/** Once a day, inside the maintenance window, off the hourly :47. */
export const INTEGRATION_WATCHDOG_DAILY_CRON = "52 4 * * *";
