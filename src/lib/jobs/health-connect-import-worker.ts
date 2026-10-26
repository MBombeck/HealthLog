/**
 * Android Health Connect export import worker (v1.42, #972).
 *
 * Reads the `health_connect_export.db` SQLite file out of an uploaded export
 * ZIP (read-only, `immutable=1`) and writes its records as `HEALTH_CONNECT`
 * rows (`src/lib/import/health-connect/`). Mirrors the Apple Health import:
 * the upload is staged to disk by the route, an `ImportJob` row
 * (`kind = "health_connect"`) carries the progress, and the run consumes its
 * staged file, so it is a one-shot with no retries.
 *
 * The person's export is plain health data on the worker's disk. Both files,
 * the upload and the extracted database, are removed in `finally` on every
 * way out, and the shared staging sweep in the Apple Health reconcile cron
 * removes anything a crash left behind (it knows both names). The terminal
 * result holds counts per type and per app, nothing else.
 */
import { rm } from "node:fs/promises";
import type { Job } from "pg-boss";

import { caughtAs, logCaught } from "@/lib/logging/signal";

import { prisma, toJson } from "@/lib/db";
import { extractHealthConnectDb } from "@/lib/import/unzip-export-xml";
import {
  importHealthConnectExport,
  type HealthConnectImportProgress,
} from "@/lib/import/health-connect/import";
import { HealthConnectImportError } from "@/lib/import/health-connect/reader";
import { connectedDirectIntegrations } from "@/lib/import/health-connect/skip-packages";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { afterBulkImport } from "@/lib/jobs/import-tail";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/** `ImportJob.kind` of the rows this worker owns. */
export const HEALTH_CONNECT_IMPORT_KIND = "health_connect";

/**
 * Parser semantics carried on the job row. The upload dedupe pins it, so a
 * change to what the importer writes for the same file bumps it and lets the
 * same bytes be imported again.
 */
export const HEALTH_CONNECT_IMPORT_PARSER_REVISION = 1;

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

/**
 * Failure reasons the card translates. Anything else is a database or
 * archive error and passes through as written.
 */
export type HealthConnectFailureCode =
  | "unsupported_version"
  | "not_health_connect"
  | "unsafe_schema"
  | "too_large"
  | "staging_missing";

function failureReason(err: unknown): string {
  if (err instanceof HealthConnectImportError) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return "staging_missing: the uploaded file is no longer on the server (a restart, or web and worker do not share the staging directory). Upload the export again.";
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The queue's work callback. pg-boss hands over an array; each import is
 * independent, so a failed one does not stop the rest, and the first failure
 * is what the batch reports.
 */
export async function handleHealthConnectImport(
  jobs: Job<HealthConnectImportPayload>[],
): Promise<JobOutcome> {
  let failure: JobOutcome | null = null;
  for (const job of jobs) {
    // Its own event per import, so the `annotate` calls below and anything
    // the import records on the ambient event reach the log instead of
    // vanishing for want of one.
    const outcome = await withBackgroundEvent(
      "job.health_connect_import",
      async (event) => {
        event.addMeta("import_job_id", job.data.importJobId);
        const result = await runHealthConnectImport(job.data);
        if (!result.ok) event.setError(result.cause ?? result.reason);
        return result;
      },
    );
    if (!outcome.ok && failure === null) failure = outcome;
  }
  return failure ?? jobDone({ jobs: jobs.length });
}

/** One import, from the staged upload to the terminal job row. */
export async function runHealthConnectImport(
  payload: HealthConnectImportPayload,
): Promise<JobOutcome> {
  const { userId, importJobId, uploadPath } = payload;
  let dbPath: string | null = null;
  try {
    const row = await prisma.importJob.findUnique({
      where: { id: importJobId },
      select: { id: true, status: true, userId: true, kind: true },
    });
    // Gone with its account, or not ours: nothing to import for.
    if (
      !row ||
      row.userId !== userId ||
      row.kind !== HEALTH_CONNECT_IMPORT_KIND
    ) {
      return jobDone({ skipped: "no_job_row" });
    }
    // A redelivery after the first run: its upload is consumed, and running
    // again could only overwrite the real outcome.
    if (row.status === "done" || row.status === "failed") {
      return jobDone({ skipped: "already_terminal" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });
    const userTimezone =
      user?.timezone && user.timezone.length > 0
        ? user.timezone
        : DEFAULT_TIMEZONE;

    await writeProgress(importJobId, "unpacking", {
      currentPhase: "parsing",
      recordsRead: 0,
      rowsUpserted: 0,
      percent: null,
      elapsedMs: 0,
    });
    const unzipped = await extractHealthConnectDb(uploadPath);
    dbPath = unzipped.dbPath;
    // The archive has served its purpose; the database is what is read.
    await rm(uploadPath, { force: true });

    await writeProgress(importJobId, "parsing", {
      currentPhase: "parsing",
      recordsRead: 0,
      rowsUpserted: 0,
      percent: null,
      elapsedMs: 0,
    });
    const connectedIntegrations = await connectedDirectIntegrations(
      prisma,
      userId,
    );
    const result = await importHealthConnectExport({
      prisma,
      dbPath,
      userId,
      userTimezone,
      connectedIntegrations,
      onProgress: (snapshot) =>
        writeProgress(importJobId, snapshot.currentPhase, snapshot),
    });

    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: "done",
        completedAt: new Date(),
        progress: toJson({
          currentPhase: "upserting",
          recordsRead: result.totals.recordsRead,
          rowsUpserted: result.totals.rowsUpserted,
          percent: 100,
          elapsedMs: result.totals.durationMs,
        }),
        result: toJson(result),
      },
    });

    // Rollups, measurement caches and status assessments over what the
    // import wrote, as the Apple Health import does (`afterBulkImport`).
    const { rollupFailed } = await afterBulkImport(
      userId,
      result,
      "health-connect-import",
    );

    annotate({
      action: { name: "import.health-connect.done" },
      meta: {
        records_read: result.totals.recordsRead,
        rows_upserted: result.totals.rowsUpserted,
        duration_ms: result.totals.durationMs,
        user_version: result.userVersion,
      },
    });
    return jobDone({
      records_read: result.totals.recordsRead,
      rows_upserted: result.totals.rowsUpserted,
      duration_ms: result.totals.durationMs,
      rollup_failed: rollupFailed,
    });
  } catch (err) {
    const reason = failureReason(err);
    try {
      await prisma.importJob.update({
        where: { id: importJobId },
        data: {
          status: "failed",
          failureReason: reason.slice(0, 1000),
          completedAt: new Date(),
        },
      });
    } catch (markErr) {
      // Usually the row went with a deleted account; say so either way.
      logCaught("health_connect.import.mark_failed_failed", markErr);
    }
    return jobFailed("health connect import failed", err);
  } finally {
    await rm(uploadPath, { force: true }).catch(
      caughtAs("health_connect.import.upload_cleanup_failed"),
    );
    if (dbPath) {
      await rm(dbPath, { force: true }).catch(
        caughtAs("health_connect.import.db_cleanup_failed"),
      );
    }
  }
}

async function writeProgress(
  importJobId: string,
  status: string,
  progress: HealthConnectImportProgress,
): Promise<void> {
  await prisma.importJob.update({
    where: { id: importJobId },
    data: { status, progress: toJson(progress) },
  });
}
