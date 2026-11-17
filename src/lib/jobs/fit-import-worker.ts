/**
 * Activity FIT file import worker.
 *
 * The upload route stages the file to disk (at most `FIT_UPLOAD_MAX_BYTES`)
 * and an `ImportJob` row (`kind = "fit"`) carries the progress the import
 * card polls, as for the Apple Health and Health Connect imports. The run
 * reads the staged file into memory (it is small), hands it to
 * `importFitUpload`, and removes the file on every way out; the shared
 * staging sweep in the import reconcile cron removes anything a crash left.
 *
 * The decode runs here, in the worker process, never in the request: the
 * file is the uploader's, and its cost is bounded by the scan's caps
 * (`src/lib/fit/scan.ts`) before the decoder starts. The job relies on
 * pg-boss's default fifteen-minute expiry, which a file under those caps
 * cannot come near, and is a one-shot (`retryLimit: 0`): the run consumes
 * its staged file, so a retry could only fail on its absence.
 *
 * The terminal result holds counts only.
 */
import { readFile, rm } from "node:fs/promises";
import type { Job } from "pg-boss";

import { prisma, toJson } from "@/lib/db";
import { FIT_UPLOAD_MAX_BYTES } from "@/lib/fit/container";
import { FitImportError } from "@/lib/fit/errors";
import { importFitUpload } from "@/lib/fit/import";
import { FIT_IMPORT_KIND } from "@/lib/jobs/fit-import-queue";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { annotate } from "@/lib/logging/context";
import { withBackgroundEvent } from "@/lib/logging/background";
import { caughtAs, logCaught } from "@/lib/logging/signal";

export { FIT_IMPORT_KIND } from "@/lib/jobs/fit-import-queue";

/**
 * Parser semantics carried on the job row. The upload dedupe pins it, so a
 * change to what the import writes for the same file bumps it and lets the
 * same bytes be imported again.
 */
export const FIT_IMPORT_PARSER_REVISION = 1;

/** One-shot: the run consumes its staged upload. Default expiry. */
export const FIT_IMPORT_SEND_OPTIONS = { retryLimit: 0 } as const;

export interface FitImportPayload {
  userId: string;
  importJobId: string;
  /** Absolute path on the worker filesystem where the upload landed. */
  uploadPath: string;
}

function failureReason(err: unknown): string {
  if (err instanceof FitImportError) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return "staging_missing: the uploaded file is no longer on the server. Upload it again.";
  }
  return err instanceof Error ? err.message : String(err);
}

export async function handleFitImport(
  jobs: Job<FitImportPayload>[],
): Promise<JobOutcome> {
  let failure: JobOutcome | null = null;
  for (const job of jobs) {
    const outcome = await withBackgroundEvent(
      "job.fit_import",
      async (event) => {
        event.addMeta("import_job_id", job.data.importJobId);
        const result = await runFitImport(job.data);
        if (!result.ok) event.setError(result.cause ?? result.reason);
        return result;
      },
    );
    if (!outcome.ok && failure === null) failure = outcome;
  }
  return failure ?? jobDone({ jobs: jobs.length });
}

/** One file, from the staged upload to the terminal job row. */
export async function runFitImport(
  payload: FitImportPayload,
): Promise<JobOutcome> {
  const { userId, importJobId, uploadPath } = payload;
  const startedAt = Date.now();
  try {
    const row = await prisma.importJob.findUnique({
      where: { id: importJobId },
      select: { status: true, userId: true, kind: true },
    });
    if (!row || row.userId !== userId || row.kind !== FIT_IMPORT_KIND) {
      return jobDone({ skipped: "no_job_row" });
    }
    if (row.status === "done" || row.status === "failed") {
      return jobDone({ skipped: "already_terminal" });
    }

    await writeProgress(importJobId, "parsing", 0);
    const upload = await readFile(uploadPath);
    // The route capped the stream; a file that grew on disk since is not ours.
    if (upload.length > FIT_UPLOAD_MAX_BYTES) {
      throw new FitImportError("too_large", "the staged file is over the cap");
    }
    await rm(uploadPath, { force: true });

    const result = await importFitUpload({ userId, upload });
    const elapsedMs = Date.now() - startedAt;
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        status: "done",
        completedAt: new Date(),
        progress: toJson({
          currentPhase: "upserting",
          recordsRead: result.sessions,
          rowsUpserted: result.imported + result.merged,
          percent: 100,
          elapsedMs,
        }),
        result: toJson(result),
      },
    });
    annotate({
      action: { name: "import.fit.done" },
      meta: {
        container: result.container,
        sessions: result.sessions,
        imported: result.imported,
        merged: result.merged,
        already_present: result.alreadyPresent,
        duration_ms: elapsedMs,
      },
    });
    return jobDone({
      sessions: result.sessions,
      imported: result.imported,
      merged: result.merged,
    });
  } catch (err) {
    const reason = failureReason(err);
    if (err instanceof FitImportError) {
      annotate({ meta: { fit_refused: err.code } });
    }
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
      logCaught("fit.import.mark_failed_failed", markErr);
    }
    // A refused file is the uploader's, not the worker's: the job did what
    // it should, and the row says why.
    if (err instanceof FitImportError) {
      return jobDone({ refused: err.code });
    }
    return jobFailed("fit import failed", err);
  } finally {
    await rm(uploadPath, { force: true }).catch(
      caughtAs("fit.import.upload_cleanup_failed"),
    );
  }
}

async function writeProgress(
  importJobId: string,
  status: string,
  elapsedMs: number,
): Promise<void> {
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      status,
      progress: toJson({
        currentPhase: status,
        recordsRead: 0,
        rowsUpserted: 0,
        percent: null,
        elapsedMs,
      }),
    },
  });
}
