/**
 * The queue facts of `dense-intraday-hourly-rebuild.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
export const DENSE_INTRADAY_HOURLY_REBUILD_QUEUE =
  "dense-intraday-hourly-rebuild";

/**
 * Serial concurrency — a rebuild walks every folded day for one account
 * with a transaction per day; concurrency-1 keeps it from crowding the
 * request pool, matching the retention drain's convention.
 */
export const DENSE_INTRADAY_HOURLY_REBUILD_CONCURRENCY = 1;
