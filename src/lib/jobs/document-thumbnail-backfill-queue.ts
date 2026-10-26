/**
 * The queue facts of `document-thumbnail-backfill.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the job so the worker
 * registry and every sender can read them without loading it.
 */
export const DOCUMENT_THUMBNAIL_BACKFILL_QUEUE = "document-thumbnail-backfill";

/** Serial concurrency — cheap discovery + fan-out enqueues. */
export const DOCUMENT_THUMBNAIL_BACKFILL_CONCURRENCY = 1;
