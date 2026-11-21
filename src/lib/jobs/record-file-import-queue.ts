/**
 * The queue facts of `record-file-import-worker.ts`, apart from the worker so
 * the registry and the upload routes can name the queue without loading a
 * parser.
 */
export const RECORD_FILE_IMPORT_QUEUE = "record-file-import";

/** One file at a time per worker. */
export const RECORD_FILE_IMPORT_CONCURRENCY = 1;
