/**
 * The queue facts of `whoop-backfill.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const WHOOP_BACKFILL_QUEUE = "whoop-backfill";

/**
 * Serial concurrency — a backfill walks years of history for one account and
 * is rate-bounded by WHOOP's 100 req/min cap; concurrency-1 keeps it from
 * crowding the request pool, matching `ROLLUP_FULL_BACKFILL_CONCURRENCY`.
 */
export const WHOOP_BACKFILL_CONCURRENCY = 1;
