/**
 * The queue facts of `document-summary-catchup.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const DOCUMENT_SUMMARY_CATCHUP_QUEUE = "document-summary-catchup";

/** Serial concurrency — cheap discovery + fan-out enqueues. */
export const DOCUMENT_SUMMARY_CATCHUP_CONCURRENCY = 1;
