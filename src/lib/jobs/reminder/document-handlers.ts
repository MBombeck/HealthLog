/**
 * Handlers of the document vault queues that are not a module's own export:
 * the content-index backfill, the per-document index, thumbnail and summary,
 * the auto-read catch-up and the thumbnail backfill. A payload without its ids
 * is counted as skipped rather than failed. The registry binds them
 * (`registry/maintenance.ts`).
 */
import type { Job } from "pg-boss";

import {
  runContentIndexBackfillForUser,
  type ContentIndexBackfillPayload,
} from "@/lib/jobs/document-content-index-backfill";
import {
  runDocumentIndex,
  type DocumentIndexPayload,
} from "@/lib/jobs/document-index";
import {
  runDocumentSummaryJob,
  type DocumentSummaryPayload,
} from "@/lib/jobs/document-summary";
import {
  runSummaryCatchUpForUser,
  type SummaryCatchUpPayload,
} from "@/lib/jobs/document-summary-catchup";
import {
  runDocumentThumbnail,
  type DocumentThumbnailPayload,
} from "@/lib/jobs/document-thumbnail";
import {
  runThumbnailBackfillForUser,
  type ThumbnailBackfillPayload,
} from "@/lib/jobs/document-thumbnail-backfill";
import { jobBudget, jobDeadline } from "@/lib/jobs/job-budget";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { recordError } from "@/lib/jobs/worker-status";

import { workerLog } from "./shared";

/**
 * The on-demand "index all documents" run for one account: consent and
 * budget gated, bounded and resumable.
 */
export async function handleContentIndexBackfill(
  jobs: Job<ContentIndexBackfillPayload>[],
): Promise<JobOutcome> {
  let users = 0;
  let stoppedEarly = false;
  const shouldStop = jobBudget(jobs);
  let skipped = 0;
  let documentsIndexed = 0;
  let documentsRetokenised = 0;
  let documentsSkipped = 0;
  let documentsFailed = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    if (!userId) {
      skipped++;
      continue;
    }
    try {
      const {
        indexed,
        retokenised,
        skipped: docsSkipped,
        failed: docsFailed,
        reason,
        stoppedEarly: stopped,
      } = await runContentIndexBackfillForUser(userId, shouldStop);
      users++;
      stoppedEarly ||= stopped === true;
      documentsIndexed += indexed;
      documentsRetokenised += retokenised;
      documentsSkipped += docsSkipped;
      documentsFailed += docsFailed;
      workerLog(
        "info",
        `[document-content-index-backfill] user=${userId} indexed=${indexed} retokenised=${retokenised} skipped=${docsSkipped} failed=${docsFailed} reason=${reason}`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[document-content-index-backfill] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    jobs: jobs.length,
    users,
    skipped,
    documents_indexed: documentsIndexed,
    documents_retokenised: documentsRetokenised,
    documents_skipped: documentsSkipped,
    documents_failed: documentsFailed,
    stopped_early: stoppedEarly,
  });
}

/** One stored document's job, by the step that runs it. */
function perDocument<P extends { userId?: string; documentId?: string }>(
  name: string,
  run: (payload: P, job: Job<P>) => Promise<unknown>,
): (jobs: Job<P>[]) => Promise<JobOutcome> {
  return async (jobs) => {
    let documents = 0;
    let skipped = 0;
    for (const job of jobs) {
      const { userId, documentId } = job.data;
      if (!userId || !documentId) {
        skipped++;
        continue;
      }
      try {
        await run(job.data, job);
        documents++;
      } catch (err) {
        recordError();
        workerLog(
          "error",
          `[${name}] user=${userId} document=${documentId} failed`,
          err,
        );
        throw err;
      }
    }
    return jobDone({ jobs: jobs.length, documents, skipped });
  };
}

/**
 * Content indexing on upload: the vision provider when configured and
 * consented, the local text layer otherwise. The lab staging after it plans
 * its reads against the job's own deadline (`jobDeadline`), so a long report
 * read by a slow model stops before pg-boss's expiry instead of being retried
 * beside itself (#1274).
 */
export function handleDocumentIndex(
  jobs: Job<DocumentIndexPayload>[],
): Promise<JobOutcome> {
  return perDocument<DocumentIndexPayload>("document-index", (payload, job) =>
    runDocumentIndex(payload, { deadlineAt: jobDeadline(job) }),
  )(jobs);
}

/** The preview thumbnail on upload: local decode and downscale, no egress. */
export const handleDocumentThumbnail = perDocument<DocumentThumbnailPayload>(
  "document-thumbnail",
  runDocumentThumbnail,
);

/**
 * The plain-language summary on upload, only with the auto-read opt-in on
 * (consent and budget gated), stored encrypted.
 */
export const handleDocumentSummary = perDocument<DocumentSummaryPayload>(
  "document-summary",
  runDocumentSummaryJob,
);

/**
 * After a genuine off-to-on flip of the auto-read opt-in: one summary job per
 * stored document the upload-time enqueue skipped. Every gate still runs
 * inside the summary job.
 */
export async function handleDocumentSummaryCatchUp(
  jobs: Job<SummaryCatchUpPayload>[],
): Promise<JobOutcome> {
  let users = 0;
  let skipped = 0;
  let summariesEnqueued = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    if (!userId) {
      skipped++;
      continue;
    }
    try {
      const { enqueued } = await runSummaryCatchUpForUser(userId);
      users++;
      summariesEnqueued += enqueued;
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[document-summary-catchup] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    jobs: jobs.length,
    users,
    skipped,
    summaries_enqueued: summariesEnqueued,
  });
}

/** One thumbnail job per not-yet-previewed document of the account. */
export async function handleDocumentThumbnailBackfill(
  jobs: Job<ThumbnailBackfillPayload>[],
): Promise<JobOutcome> {
  let users = 0;
  let skipped = 0;
  let thumbnailsEnqueued = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    if (!userId) {
      skipped++;
      continue;
    }
    try {
      const { enqueued } = await runThumbnailBackfillForUser(userId);
      users++;
      thumbnailsEnqueued += enqueued;
      workerLog(
        "info",
        `[document-thumbnail-backfill] user=${userId} enqueued=${enqueued}`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[document-thumbnail-backfill] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    jobs: jobs.length,
    users,
    skipped,
    thumbnails_enqueued: thumbnailsEnqueued,
  });
}
