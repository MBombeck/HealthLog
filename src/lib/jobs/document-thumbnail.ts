/**
 * Automatic per-document preview thumbnail, enqueued the moment a document is
 * stored (`POST /api/documents/inbound`). Fire-and-forget: the upload response
 * never blocks on or fails because of thumbnail rendering.
 *
 * The job decrypts the stored original (owner-scoped), renders a small JPEG
 * preview (`generateThumbnail` — images downscaled, a PDF's first page
 * rasterised, every other type skipped), and upserts it encrypted into the 1:1
 * `DocumentThumbnail` side table. Pure local compute — no egress, no consent
 * or budget gate. Serial concurrency keeps the canvas/pdfjs decode off the
 * request pool.
 *
 * NEVER fails a document for an expected outcome: an unsupported MIME or an
 * unrenderable file leaves the document without a thumbnail (the card shows its
 * kind icon), and `runDocumentThumbnail` returns cleanly so pg-boss does not
 * retry it. Only an unexpected throw (a DB hiccup) propagates for retry.
 *
 * Each run is one background wide event (`job.document_thumbnail`). A run
 * that should have produced a preview and did not is raised to `warn` with
 * the reason, so a document left with its kind icon is explained in the log.
 * Without the event every annotation below went nowhere: a whole class of
 * PDFs went without previews for weeks and the log never said so.
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import { prisma } from "@/lib/db";
import {
  decryptDocumentContent,
  encryptThumbnail,
} from "@/lib/documents/store";
import { generateThumbnail } from "@/lib/documents/thumbnail";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { withBackgroundEvent } from "@/lib/logging/background";
import { annotate } from "@/lib/logging/context";

export const DOCUMENT_THUMBNAIL_QUEUE = "document-thumbnail";

/** Serial concurrency — canvas/pdfjs decode, kept off the request pool. */
export const DOCUMENT_THUMBNAIL_CONCURRENCY = 1;

export interface DocumentThumbnailPayload {
  userId: string;
  documentId: string;
  enqueuedAt?: string;
}

/**
 * Render + store one document's preview thumbnail (owner-scoped). Idempotent:
 * a document that already has a thumbnail is skipped, and an unsupported /
 * unrenderable document is left without one. Never throws for an expected
 * outcome.
 */
export async function runDocumentThumbnail(
  payload: DocumentThumbnailPayload,
): Promise<void> {
  const { userId, documentId } = payload;
  if (!userId || !documentId) return;
  await withBackgroundEvent("job.document_thumbnail", async (evt) => {
    evt.addMeta("document_id", documentId);
    await renderThumbnail(userId, documentId, (reason) => {
      evt.addMeta("thumbnail_missing_reason", reason);
      evt.elevateLevel("warn");
    });
  });
}

async function renderThumbnail(
  userId: string,
  documentId: string,
  warn: (reason: string) => void,
): Promise<void> {
  // Owner-scoped load; the blob column is selected ONLY here (the job that
  // renders the preview), never in the list/detail queries. Skip a document
  // that already has a thumbnail so a re-enqueue is a cheap no-op.
  const document = await prisma.inboundDocument.findFirst({
    where: { id: documentId, userId, deletedAt: null },
    select: {
      id: true,
      mimeType: true,
      contentEncrypted: true,
      contentCodec: true,
      thumbnail: { select: { id: true } },
    },
  });
  if (!document || document.thumbnail) {
    annotate({
      action: { name: "documents.thumbnail.skipped" },
      meta: { documentId, reason: !document ? "not-found" : "exists" },
    });
    return;
  }

  let bytes: Buffer;
  try {
    bytes = decryptDocumentContent(
      document.contentEncrypted,
      document.contentCodec,
    );
  } catch {
    // Fail-closed decrypt: a bad / missing key id leaves the document without a
    // thumbnail (the card shows its icon); never log the bytes.
    annotate({
      action: { name: "documents.thumbnail.decryptFailed" },
      meta: { documentId },
    });
    warn("decrypt-failed");
    return;
  }

  const result = await generateThumbnail(bytes, document.mimeType);
  if (!result.ok) {
    annotate({
      action: { name: "documents.thumbnail.run" },
      meta: { documentId, generated: false, mimeType: document.mimeType },
    });
    // An Office or text document has no preview by design; anything else
    // was meant to get one.
    if (result.reason !== "unsupported-type") warn(result.reason);
    return;
  }

  const { jpeg, width, height } = result.thumbnail;
  // Upsert (not create) so a racing re-enqueue cannot violate the 1:1 unique
  // index; the last render wins. `userId` comes from the scoped load, never a
  // body — no mass assignment.
  await prisma.documentThumbnail.upsert({
    where: { documentId: document.id },
    create: {
      documentId: document.id,
      userId,
      thumbnailEncrypted: encryptThumbnail(jpeg),
      width,
      height,
      byteSize: jpeg.byteLength,
      sourceMime: document.mimeType,
    },
    update: {
      thumbnailEncrypted: encryptThumbnail(jpeg),
      width,
      height,
      byteSize: jpeg.byteLength,
      sourceMime: document.mimeType,
    },
  });

  annotate({
    action: { name: "documents.thumbnail.run" },
    meta: { documentId, generated: true, byteSize: jpeg.byteLength },
  });
}

/**
 * Enqueue a per-document thumbnail job. Coalesced by `singletonKey` per
 * document so a duplicate/idempotent re-upload cannot pile up parallel runs.
 * Fire-and-forget — a missing boss (worker not up) is a no-op, and a
 * `boss.send` failure (a transient DB hiccup) is swallowed to a no-op too, so
 * enqueue can NEVER fail an already-stored upload. A dropped enqueue is
 * recoverable via the corpus backfill.
 */
export async function enqueueDocumentThumbnail(
  userId: string,
  documentId: string,
): Promise<{ enqueued: boolean }> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  const payload: DocumentThumbnailPayload = {
    userId,
    documentId,
    enqueuedAt: new Date().toISOString(),
  };
  try {
    const jobId = await boss.send(DOCUMENT_THUMBNAIL_QUEUE, payload, {
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
      singletonKey: `document-thumbnail|${documentId}`,
    });
    return { enqueued: Boolean(jobId) };
  } catch (err) {
    annotate({
      action: { name: "documents.thumbnail.enqueueFailed" },
      meta: { documentId, reason: err instanceof Error ? err.name : "unknown" },
    });
    return { enqueued: false };
  }
}
