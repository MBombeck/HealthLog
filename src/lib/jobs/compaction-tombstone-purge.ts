/**
 * Backlog purge of compaction tombstones (v1.42).
 *
 * The dense-intraday consolidation used to soft-delete the raw rows it folded
 * into an hourly or daily `stats:` row. Those tombstones ("class A") never
 * reach a client as a meaningful deletion and only weigh on the
 * `measurements` table and its indexes. This queue removes the backlog in
 * batches of 5 000 rows, each batch under `holdAccountAgainstRestore`; the
 * delete predicate is idempotent, so a run that stops early simply resumes on
 * the next one. User deletions ("class B") are never touched here and keep
 * their 75-day retention.
 *
 * Contract stub: the queue is registered and bound so the registrar, the
 * runtime table and the subsystem surface are settled. The handler refuses to
 * claim success until the purge is implemented, and the boot enqueue sends
 * nothing yet.
 */
import { jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";

export const COMPACTION_TOMBSTONE_PURGE_QUEUE = "compaction-tombstone-purge";

/** Empty payload: one run walks every account. */
export type CompactionTombstonePurgePayload = Record<string, never>;

export async function handleCompactionTombstonePurge(): Promise<JobOutcome> {
  return jobFailed("compaction tombstone purge not implemented");
}

/**
 * Queue one purge run when the worker boots. The run is self-limiting, so a
 * boot that finds no backlog costs one cheap query. Sends nothing until the
 * purge is implemented.
 */
export async function enqueueBootTimeCompactionTombstonePurge(): Promise<{
  enqueued: boolean;
}> {
  return { enqueued: false };
}
