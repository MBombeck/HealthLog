/**
 * The queue facts of `sleep-timeline-backfill.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const SLEEP_TIMELINE_BACKFILL_QUEUE = "sleep-timeline-backfill";

/**
 * Serial concurrency — a pass deletes a source's sleep rows then walks a
 * re-sync that is rate-bounded by the upstream API cap. Concurrency-1 keeps it
 * from crowding the request pool, matching the other backfill queues.
 */
export const SLEEP_TIMELINE_BACKFILL_CONCURRENCY = 1;
