/**
 * Daily physical purge for soft-deleted document-vault rows.
 *
 * Delete in the vault is undo-able: the DELETE route tombstones
 * (`deletedAt`), the UI's undo toast and the restore endpoint clear the
 * tombstone, and THIS job hard-deletes tombstones older than the 30-day
 * grace window — returning the TOAST space the encrypted blob holds (a
 * tombstoned document keeps counting against the quota until purged, so
 * "deleted" bytes are never invisible backup weight). Staged facts cascade
 * via the FK. Restore-after-purge answers 409 at the API. An imported
 * document's source key is carried to `DocumentImportKey` on the way out
 * (`src/lib/documents/tombstones.ts`, shared with "Delete now").
 */
import { type Job } from "pg-boss";
import { DOCUMENT_PURGE_GRACE_DAYS } from "@/lib/jobs/document-purge-queue";
import { purgeDocumentTombstones } from "@/lib/documents/tombstones";
import { withBackgroundEvent } from "@/lib/logging/background";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import type { PrismaClient } from "@/generated/prisma/client";

export {
  DOCUMENT_PURGE_CRON,
  DOCUMENT_PURGE_QUEUE,
} from "@/lib/jobs/document-purge-queue";

const DAY_MS = 86_400_000;

export interface DocumentPurgePayload {
  triggeredAt?: string;
}

/**
 * Hard-delete tombstoned `inbound_documents` rows whose `deletedAt` is older
 * than the grace horizon. Returns the number of rows purged. Rows inside the
 * grace window and live rows are never touched.
 *
 * v1.39.2 (#1038) — an imported document's source key outlives its row: the
 * shared purge (`purgeDocumentTombstones`, the same one "Delete now" in
 * Recently deleted runs) copies it into the ledger in the same transaction as
 * the delete, so a re-run of the importer does not store the document again.
 */
export async function purgeExpiredDocumentTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - DOCUMENT_PURGE_GRACE_DAYS * DAY_MS);
  return prisma.$transaction((tx) =>
    purgeDocumentTombstones(tx, { deletedAt: { lt: cutoff } }),
  );
}

export async function handleDocumentPurge(
  jobs: Job<DocumentPurgePayload>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.document_tombstone_purge", async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const purged = await purgeExpiredDocumentTombstones(prisma);
      evt.setAction({ name: "documents.vault.purge" });
      evt.addMeta("document_purge_deleted", purged);
      // A night with no expired tombstone purges nothing and is still a run
      // that did its work — the zero is the fact, not an absence of one.
      return jobDone({ document_purge_deleted: purged });
    } catch (err) {
      evt.addWarning(`document-tombstone-purge failed: ${err}`);
      return jobFailed("document tombstone purge failed", err);
    }
  });
}
