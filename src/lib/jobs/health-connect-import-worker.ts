/**
 * Android Health Connect export import worker (v1.42, #972).
 *
 * Reads the `health_connect_export.db` SQLite file out of an uploaded export
 * ZIP (read-only, `immutable=1`) and writes its records as `HEALTH_CONNECT`
 * measurements through the same reconciliation path the other external
 * sources use. Mirrors the Apple Health import: the upload is staged to disk
 * by the route, an `ImportJob` row (`kind = "health_connect"`) carries the
 * progress, and the run consumes its staged file, so it is a one-shot.
 *
 * Contract stub: the queue is registered and bound; the handler refuses to
 * claim success until the importer is implemented.
 */
import { jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";

export const HEALTH_CONNECT_IMPORT_QUEUE = "health-connect-import";

/** One import at a time per worker: the SQLite read and the writes are heavy. */
export const HEALTH_CONNECT_IMPORT_CONCURRENCY = 1;

/** Same shape and reasoning as `APPLE_HEALTH_IMPORT_SEND_OPTIONS`. */
export const HEALTH_CONNECT_IMPORT_SEND_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: 6 * 60 * 60,
} as const;

/** Payload `boss.send` carries onto the queue. */
export interface HealthConnectImportPayload {
  /** Owner of the imported rows. */
  userId: string;
  /** The `ImportJob` row that mirrors this run. */
  importJobId: string;
  /** Absolute path on the worker filesystem where the upload landed. */
  uploadPath: string;
}

export async function handleHealthConnectImport(): Promise<JobOutcome> {
  return jobFailed("health connect import not implemented");
}
