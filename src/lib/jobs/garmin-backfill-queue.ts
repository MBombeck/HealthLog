/**
 * The queue facts of `garmin-backfill.ts`: its name and concurrency, apart
 * from the handler so the worker registry and every sender can read them
 * without loading the job.
 */
export const GARMIN_BACKFILL_QUEUE = "garmin-backfill";

/** One account at a time; the shared lane bounds the instance. */
export const GARMIN_BACKFILL_CONCURRENCY = 1;
