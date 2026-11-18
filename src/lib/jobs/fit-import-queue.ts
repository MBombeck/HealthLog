/**
 * The queue facts of `fit-import-worker.ts`, apart from the worker so the
 * registry and the upload route can name the queue without loading the
 * decoder.
 */
export const FIT_IMPORT_QUEUE = "fit-import";

/** One file at a time per worker; a file is small and quick. */
export const FIT_IMPORT_CONCURRENCY = 1;

/** `ImportJob.kind` of the rows the FIT import owns. */
export const FIT_IMPORT_KIND = "fit";
