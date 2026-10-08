/**
 * Operator-triggered maintenance of the `measurements` table (v1.42).
 *
 * `VACUUM (ANALYZE)` and a `REINDEX INDEX CONCURRENTLY` per index, largest
 * first, after the compaction-tombstone purge has shrunk the table. Neither
 * statement can run inside a transaction, so this is a job rather than a
 * Prisma migration. Started only from `POST /api/admin/maintenance/measurements`
 * (cookie-only admin), never on a schedule: the operator picks a quiet window.
 * Runbook: `docs/ops/measurement-maintenance.md`.
 *
 * Contract stub: the queue is registered and bound; the handler refuses to
 * claim success until the maintenance pass is implemented.
 */
import { jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";

export const MEASUREMENT_MAINTENANCE_QUEUE = "measurement-maintenance";

/**
 * A REINDEX of the largest index on a big instance takes well past pg-boss's
 * default fifteen minutes. One-shot: a retry would start the pass over beside
 * a half-finished one, so the operator re-triggers instead.
 */
export const MEASUREMENT_MAINTENANCE_SEND_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: 6 * 60 * 60,
  singletonKey: "measurement-maintenance",
} as const;

/** Which steps the operator asked for. */
export interface MeasurementMaintenancePayload {
  vacuum: boolean;
  reindex: boolean;
}

export async function handleMeasurementMaintenance(): Promise<JobOutcome> {
  return jobFailed("measurement maintenance not implemented");
}
