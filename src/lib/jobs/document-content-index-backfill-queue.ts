/**
 * The queue facts of `document-content-index-backfill.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const CONTENT_INDEX_BACKFILL_QUEUE = "document-content-index-backfill";

/** Serial concurrency — provider calls, kept off the request pool. */
export const CONTENT_INDEX_BACKFILL_CONCURRENCY = 1;
