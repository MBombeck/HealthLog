/**
 * The queue facts of `medications/intake-slot-dedup.ts`: its name and
 * concurrency. They live apart from the handler so the worker registry can
 * read them without loading the dedup pass and the device notices it sends.
 */
export const INTAKE_SLOT_DEDUP_QUEUE = "intake-slot-dedup";

/**
 * Serial concurrency — the populator walks a user's intake events and
 * writes per slot; concurrency-1 keeps it from crowding the request
 * pool, matching the other boot-time backfills.
 */
export const INTAKE_SLOT_DEDUP_CONCURRENCY = 1;
