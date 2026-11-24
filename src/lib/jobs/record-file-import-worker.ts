/**
 * The record-file import worker: a Gadgetbridge database export or a FHIR R4
 * Bundle, staged to disk by its upload route and imported here, never in the
 * request (`src/lib/import/file-import/`).
 *
 * One-shot (`retryLimit: 0`): the run consumes its staged file. The importer
 * checks its time budget between batches; a run that reaches it keeps what it
 * wrote and fails the job with `time_budget`, so the person can upload the
 * same file again and the rows already written are found under their
 * identities. The terminal result holds counts and closed reasons only.
 */
import { rm } from "node:fs/promises";
import type { Job } from "pg-boss";

import type { MeasurementType } from "@/generated/prisma/client";
import { prisma, toJson } from "@/lib/db";
import {
  RECORD_FILE_IMPORT_KINDS,
  RecordFileImportError,
  type RecordFileImportResult,
} from "@/lib/import/file-import/kinds";
import { RecordFileImportTally } from "@/lib/import/file-import/tally";
import type { RecordFileImportPayload } from "@/lib/import/file-import/upload";
import { afterBulkImport } from "@/lib/jobs/import-tail";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { annotate } from "@/lib/logging/context";
import { caughtAs, logCaught } from "@/lib/logging/signal";
import { resolveUserTimezone } from "@/lib/tz/resolver";

const MEASUREMENT_TYPE_KEY = /^[A-Z][A-Z0-9_]+$/;

function failureReason(err: unknown): string {
  if (err instanceof RecordFileImportError) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    return "staging_missing: the uploaded file is no longer on the server. Upload it again.";
  }
  // The error itself goes to the run's event; the row keeps a closed code.
  return "import_failed: the import stopped on an unexpected error. Upload the file again.";
}

export async function handleRecordFileImport(
  jobs: Job<RecordFileImportPayload>[],
): Promise<JobOutcome> {
  // The run stops on the job's budget as well as on its own ten minutes.
  const outOfJobTime = jobBudget(jobs);
  let failure: JobOutcome | null = null;
  for (const job of jobs) {
    const outcome = await withBackgroundEvent(
      "job.record_file_import",
      async (event) => {
        event.addMeta("import_job_id", job.data.importJobId);
        event.addMeta("import_kind", job.data.kind);
        const result = await runRecordFileImport(job.data, outOfJobTime);
        if (!result.ok) event.setError(result.cause ?? result.reason);
        return result;
      },
    );
    if (!outcome.ok && failure === null) failure = outcome;
  }
  return failure ?? jobDone({ jobs: jobs.length });
}

async function importByKind(
  payload: RecordFileImportPayload,
  tally: RecordFileImportTally,
  tz: string,
): Promise<void> {
  if (payload.kind === "gadgetbridge") {
    const { importGadgetbridgeExport } =
      await import("@/lib/import/gadgetbridge/import");
    await importGadgetbridgeExport({
      userId: payload.userId,
      dbPath: payload.uploadPath,
      tz,
      tally,
    });
    return;
  }
  const { importFhirBundleFile } =
    await import("@/lib/import/fhir-bundle/import");
  await importFhirBundleFile({
    userId: payload.userId,
    path: payload.uploadPath,
    tz,
    tally,
  });
}

/** One file, from the staged upload to the terminal job row. */
export async function runRecordFileImport(
  payload: RecordFileImportPayload,
  stop: () => boolean = () => false,
): Promise<JobOutcome> {
  const { userId, importJobId, uploadPath, kind } = payload;
  try {
    const row = await prisma.importJob.findUnique({
      where: { id: importJobId },
      select: { status: true, userId: true, kind: true },
    });
    if (
      !row ||
      row.userId !== userId ||
      row.kind !== kind ||
      !(RECORD_FILE_IMPORT_KINDS as readonly string[]).includes(kind)
    ) {
      return jobDone({ skipped: "no_job_row" });
    }
    if (row.status === "done" || row.status === "failed") {
      return jobDone({ skipped: "already_terminal" });
    }
    await prisma.importJob.update({
      where: { id: importJobId },
      data: { status: "parsing" },
    });

    const tz = await resolveUserTimezone(userId);
    const tally = new RecordFileImportTally(kind, undefined, stop);
    await importByKind(payload, tally, tz);
    const result = tally.toResult();
    await finish(importJobId, result);
    const { rollupFailed } = await afterBulkImport(
      userId,
      toImportTail(result),
      `${kind}-import`,
    );
    annotate({
      action: { name: `import.${kind}.done` },
      meta: {
        imported: result.imported,
        duplicates: result.duplicates,
        skipped: result.skipped,
        failed: result.failed,
        budget_exceeded: result.budgetExceeded,
        duration_ms: result.durationMs,
      },
    });
    // The rollup recompute after the import fails soft, as for the other
    // bulk imports; the run carries it (`FanOutTally`).
    return jobDone({
      imported: result.imported,
      skipped: result.skipped,
      rollup_failed: rollupFailed,
      items_attempted: 1,
      items_failed: rollupFailed ? 1 : 0,
      partial_failed: rollupFailed,
    });
  } catch (err) {
    const reason = failureReason(err);
    if (err instanceof RecordFileImportError) {
      annotate({ meta: { import_refused: err.code } });
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
      logCaught("record_file.import.mark_failed_failed", markErr);
    }
    // A refused file is the uploader's, not the worker's.
    if (err instanceof RecordFileImportError) {
      return jobDone({ refused: err.code });
    }
    return jobFailed("record file import failed", err);
  } finally {
    await rm(uploadPath, { force: true }).catch(
      caughtAs("record_file.import.upload_cleanup_failed"),
    );
  }
}

/**
 * The terminal row. A run that reached its budget is `failed` with
 * `time_budget`, so the same bytes may be uploaded again (the dedupe skips
 * only jobs that did not fail) and continue; its counts stay on the row.
 */
async function finish(
  importJobId: string,
  result: RecordFileImportResult,
): Promise<void> {
  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      status: result.budgetExceeded ? "failed" : "done",
      completedAt: new Date(),
      result: toJson(result),
      ...(result.budgetExceeded
        ? {
            failureReason:
              "time_budget: the import stopped at its time limit. Upload the same file again to continue.",
          }
        : {}),
    },
  });
}

/** The rollup and cache tail reads measurement types only. */
function toImportTail(result: RecordFileImportResult) {
  const perType: Record<string, { inserted: number; updated: number }> = {};
  for (const line of result.lines) {
    if (!MEASUREMENT_TYPE_KEY.test(line.key)) continue;
    perType[line.key as MeasurementType] = {
      inserted: line.imported,
      updated: 0,
    };
  }
  return { measuredSpan: result.measuredSpan, perType };
}
