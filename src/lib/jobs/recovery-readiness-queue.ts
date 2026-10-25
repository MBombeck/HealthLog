/**
 * The queue facts of `recovery-readiness.ts`: its name and schedule. They live
 * apart from the job so the worker registry can read them without loading it.
 */
export const RECOVERY_READINESS_QUEUE = "recovery-readiness";

/**
 * Hourly at :33, a minute no other schedule uses. Hourly is far inside every
 * threshold the evaluation judges (36 hours for the dump, two nights for the
 * off-host copies), and a notice is sent once per change whatever the cadence.
 */
export const RECOVERY_READINESS_CRON = "33 * * * *";
