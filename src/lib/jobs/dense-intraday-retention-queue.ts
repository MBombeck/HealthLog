/**
 * The queue facts of `dense-intraday-retention.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
export const DENSE_INTRADAY_RETENTION_QUEUE = "dense-intraday-retention";

/**
 * Serial concurrency — the drain walks every out-of-window per-sample
 * dense-tier row for a user and writes a transaction per day;
 * concurrency-1 keeps it from crowding the request pool, matching the
 * mean-consolidation + step-consolidation convention.
 */
export const DENSE_INTRADAY_RETENTION_CONCURRENCY = 1;
