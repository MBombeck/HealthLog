/**
 * The queue facts of `document-thumbnail.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the job so the worker
 * registry and every sender can read them without loading it.
 */
export const DOCUMENT_THUMBNAIL_QUEUE = "document-thumbnail";

/** Serial concurrency — canvas/pdfjs decode, kept off the request pool. */
export const DOCUMENT_THUMBNAIL_CONCURRENCY = 1;
