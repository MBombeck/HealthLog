/**
 * The queue facts of `document-purge.ts`: its name, its schedule and the grace
 * window it enforces. They live apart from the handler so the worker registry
 * can read them without loading the purge (and the document modules it shares
 * with "Delete now"). Constants only: client code reads the grace window
 * through `@/lib/documents/inbound-constants`.
 */
export const DOCUMENT_PURGE_QUEUE = "document-tombstone-purge";
/** Daily at 04:10 Europe/Berlin — after the med-notes backfill tick (04:05). */
export const DOCUMENT_PURGE_CRON = "10 4 * * *";

/**
 * Days a deleted document stays in Recently deleted (restorable) before the
 * daily purge removes it for good. The purge, the list of deleted documents
 * and the copy that names the window all read this one value.
 */
export const DOCUMENT_PURGE_GRACE_DAYS = 30;
