/**
 * What a queued restore is waiting for, read from the queue itself.
 *
 * A restore runs in the heavy lane (`heavy-lane.ts`): while a backup pass or
 * another large job holds it, the restore goes back to its queue for a minute
 * at a time, so it never runs beside one. That is deliberate, and invisible
 * from the restore's own row, which says `queued` for the whole wait. The
 * console said the restore starts "as soon as the background worker picks it
 * up", which read as a stuck worker while a backup ran for half an hour.
 *
 * The queue knows. A delivery the lane put back sits in `created` with a
 * `start_after` ahead of now, and the job holding the lane is the active row
 * of a heavy queue. Reading both answers the question without a column that
 * would have to be kept in step with the lane.
 */
import { prisma } from "@/lib/db";
import { HEAVY_QUEUES } from "@/lib/jobs/heavy-lane";
import { logCaught } from "@/lib/logging/signal";

import { BACKUP_RESTORE_QUEUE } from "./backup-restore-queue";

/**
 * Why a queued restore has not started: a backup pass holds the lane, or
 * something else does (an import, a nightly pass, the memory guard).
 */
export type RestoreWait = "backup" | "busy";

/** The queues whose holder the console names as "the backup". */
const BACKUP_PASS_QUEUES: ReadonlySet<string> = new Set([
  "data-backup",
  "data-backup-offhost",
]);

const OTHER_HEAVY_QUEUES = Object.keys(HEAVY_QUEUES).filter(
  (queue) => queue !== BACKUP_RESTORE_QUEUE,
);

/**
 * For each of `deliveries` (pg-boss job ids of queued restores) that the lane
 * has put back, what holds the lane. A delivery not in the map is waiting
 * for the worker to pick it up, nothing more.
 *
 * Never fails the read it serves: a queue that cannot be asked answers no
 * waits, reported at warn, and the console says what it said before.
 */
export async function restoreWaits(
  deliveries: readonly string[],
): Promise<Map<string, RestoreWait>> {
  const waits = new Map<string, RestoreWait>();
  if (deliveries.length === 0) return waits;
  try {
    const deferred = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id
      FROM pgboss.job
      WHERE name = ${BACKUP_RESTORE_QUEUE}
        AND id = ANY(${[...deliveries]}::uuid[])
        AND state = 'created'
        AND start_after > now()
    `;
    if (deferred.length === 0) return waits;
    const holders = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name
      FROM pgboss.job
      WHERE state = 'active'
        AND name = ANY(${OTHER_HEAVY_QUEUES}::text[])
      ORDER BY started_on ASC
      LIMIT 1
    `;
    const holder = holders[0]?.name;
    const wait: RestoreWait =
      holder !== undefined && BACKUP_PASS_QUEUES.has(holder)
        ? "backup"
        : "busy";
    for (const row of deferred) waits.set(row.id, wait);
  } catch (err) {
    logCaught("backup.restore.wait_unread", err);
  }
  return waits;
}
