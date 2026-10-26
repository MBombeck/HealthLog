/**
 * The queue facts of `strava-backfill.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const STRAVA_BACKFILL_QUEUE = "strava-backfill";

/**
 * Serial concurrency — a backfill walks the account's activity history and is
 * rate-bounded by Strava's 200-req / 15-min cap; concurrency-1 keeps it from
 * crowding the request pool, matching `WHOOP_BACKFILL_CONCURRENCY`.
 */
export const STRAVA_BACKFILL_CONCURRENCY = 1;
