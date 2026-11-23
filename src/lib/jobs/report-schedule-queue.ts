/**
 * The queue facts of `report-schedule.ts`: its name, schedule and per-tick
 * cap. They live apart from the handler so the worker registry can read them
 * without loading the job.
 */
export const REPORT_SCHEDULE_QUEUE = "report-schedule";

/**
 * Hourly at :25 (Europe/Berlin). Most ticks find nothing due and cost one
 * indexed read; on the first day of a month the reports due that day drain
 * over a few ticks, {@link REPORT_SCHEDULE_MAX_PER_TICK} at a time, rather
 * than rendering every PDF of the instance in one run.
 */
export const REPORT_SCHEDULE_CRON = "25 * * * *";

/** Reports rendered in one tick; the rest wait for the next. */
export const REPORT_SCHEDULE_MAX_PER_TICK = 20;
