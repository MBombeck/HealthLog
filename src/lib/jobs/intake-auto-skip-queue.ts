/**
 * The queue facts of `intake-auto-skip.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const INTAKE_AUTO_SKIP_QUEUE = "intake-auto-skip";

/**
 * Cron schedule. Hourly at :05 so the tick doesn't collide with the
 * top-of-the-hour reminder-check (:00) or the rollup fold (:30)
 * cadences. Europe/Berlin matches the rest of the worker's schedules.
 */
export const INTAKE_AUTO_SKIP_CRON = "5 * * * *";
