/**
 * The queue facts of `oura-backfill.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const OURA_BACKFILL_QUEUE = "oura-backfill";

/** One account at a time; the shared lane bounds the instance. */
export const OURA_BACKFILL_CONCURRENCY = 1;
