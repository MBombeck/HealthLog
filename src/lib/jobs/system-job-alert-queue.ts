/**
 * The queue facts of `system-job-alert.ts`: its name and schedule. They live
 * apart from the job so the worker registry can read them without loading it.
 */
export const SYSTEM_JOB_ALERT_QUEUE = "system-job-alert";

/**
 * Hourly at :43, a minute no other schedule uses. A notice goes out once per
 * change whatever the cadence, and an hour is soon enough to hear that a
 * background job keeps failing.
 */
export const SYSTEM_JOB_ALERT_CRON = "43 * * * *";
