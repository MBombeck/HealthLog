/**
 * The queue facts of `intake-auto-take.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const INTAKE_AUTO_TAKE_QUEUE = "intake-auto-take";

/**
 * Every 15 minutes, off the reminder tick (:00/:15/:30/:45) and the hourly
 * auto-miss pass (:05). A 19:00 dose reads taken by 19:10 at the latest.
 */
export const INTAKE_AUTO_TAKE_CRON = "10,25,40,55 * * * *";
