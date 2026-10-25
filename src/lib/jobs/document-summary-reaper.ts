/**
 * Hourly reaper for document-summary rows stuck on PENDING.
 *
 * PENDING promises the reader "a job will resolve this" — and the enqueue
 * side only claims it once a pg-boss job genuinely exists. But a job can
 * still die past its retry budget (worker crash, provider outage outliving
 * retryLimit:2), and a soft-deleted-then-restored document can outlive the
 * queue row entirely. Nothing then ever writes a terminal state, so the
 * detail sheet says "wird generiert" forever and the OpenAPI-exported state
 * keeps exporting the lie.
 *
 * Two ends close it (both against the same TTL):
 *   - read-time: `serialiseDocumentDetail` degrades a stale PENDING to
 *     UNAVAILABLE, so the very next detail open is honest;
 *   - this sweep: persists the same heal, so list chips, exports and any
 *     other reader converge too. Mirrors the orphan-ImportJob reconcile
 *     precedent (a stuck in-flight marker must converge to a visible
 *     terminal state within a couple of ticks).
 *
 * UNAVAILABLE is the honest terminal here — "could not produce" — and the
 * detail view offers the manual generate button in that state, so the user
 * regains the action a dead PENDING was hiding. A job that does eventually
 * run after the heal still wins: the summary writer flips any non-READY
 * state to READY when it lands.
 */
import { type Job } from "pg-boss";
import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import { SUMMARY_PENDING_TTL_MS } from "@/lib/documents/store";
import type { PrismaClient } from "@/generated/prisma/client";

export interface DocumentSummaryReaperPayload {
  triggeredAt?: string;
}

/**
 * Flip PENDING rows whose last write is older than the TTL to UNAVAILABLE.
 * Returns the number of rows healed. `updatedAt` is the staleness clock —
 * the PENDING claim bumps it, and any later legitimate progress does too,
 * so a row still moving is never claimed.
 */
export async function reapStalePendingSummaries(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - SUMMARY_PENDING_TTL_MS);
  // account-deletion: releases summaries stuck in PENDING by a run that died; it starts no work.
  const { count } = await prisma.inboundDocument.updateMany({
    where: { summaryState: "PENDING", updatedAt: { lt: cutoff } },
    data: { summaryState: "UNAVAILABLE" },
  });
  return count;
}

export async function handleDocumentSummaryReaper(
  jobs: Job<DocumentSummaryReaperPayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.document_summary_reaper", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const healed = await reapStalePendingSummaries(prisma);
      evt.setAction({ name: "documents.summary.reap_stale_pending" });
      evt.addMeta("summary_pending_healed", healed);
      // A tick with nothing stuck heals zero rows and is still a run that
      // did its work — the zero is the fact, not an absence of one.
      return jobDone({ summary_pending_healed: healed });
    } catch (err) {
      evt.addWarning(`document-summary-reaper failed: ${err}`);
      return jobFailed("document summary reaper failed", err);
    }
  });
}
