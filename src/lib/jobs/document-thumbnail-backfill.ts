/**
 * Preview-thumbnail backfill for a user's EXISTING stored documents.
 *
 * For each live document whose type can carry a preview (image or PDF) and
 * that has no `DocumentThumbnail` yet, enqueue a per-document thumbnail job.
 * This covers pre-feature documents and any dropped upload-time enqueue — a
 * missing thumbnail is always recoverable; the card just shows its kind icon
 * meanwhile.
 *
 * Fired on boot (one per-user pass per account holding thumbnailable documents
 * that lack a preview). Pure local compute downstream (no egress, no consent
 * or budget gate), so — unlike the content-index backfill — it needs no
 * consent receipt. Bounded + resumable: an id-cursor forward walk over the
 * not-yet-thumbnailed set, capped at `MAX_ENQUEUES_PER_RUN` per job. A document
 * drops out of the set the moment its thumbnail row lands, so the walk
 * converges and a re-run picks up where the cap left off.
 *
 * A document whose render failed for good drops out too
 * (`DocumentThumbnailFailure`, see {@link thumbnailRetryDue}): a PDF whose
 * first page renders blank never gets a thumbnail, and without the record it
 * was queued again at every boot, without end.
 *
 * The queue MUST be registered in the maintenance registrar
 * (`src/lib/jobs/reminder/register-maintenance.ts`) so pg-boss provisions it.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { nativeCanvasSupported } from "@/lib/documents/native-canvas-support";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { enqueueDocumentThumbnail } from "@/lib/jobs/document-thumbnail";
import { annotate } from "@/lib/logging/context";

export const DOCUMENT_THUMBNAIL_BACKFILL_QUEUE = "document-thumbnail-backfill";

/** Serial concurrency — cheap discovery + fan-out enqueues. */
export const DOCUMENT_THUMBNAIL_BACKFILL_CONCURRENCY = 1;

/** Discovery page size (id-only). */
const PAGE_SIZE = 100;

/** Max per-document jobs one backfill pass enqueues before yielding. */
const MAX_ENQUEUES_PER_RUN = 1000;

/** MIME types a preview can be rendered from (image + PDF). */
const THUMBNAILABLE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;

/**
 * Render refusals that the same bytes will always get again: the first page
 * renders blank, the render comes out empty, the image is past the pixel cap.
 * One attempt settles them.
 */
const FINAL_THUMBNAIL_FAILURES = [
  "raster-failed",
  "empty-render",
  "pixel-cap",
] as const;

/** Attempts any other failure (a throw, a key that did not open) gets. */
export const MAX_THUMBNAIL_ATTEMPTS = 3;

/**
 * Whether a document whose render failed is due another try: never after a
 * final refusal or the last attempt, unless the document changed since. The
 * boot discovery's SQL states the same rule.
 */
export function thumbnailRetryDue(
  failure: { reason: string; attempts: number; failedAt: Date } | null,
  documentUpdatedAt: Date,
): boolean {
  if (!failure) return true;
  if (documentUpdatedAt > failure.failedAt) return true;
  if (
    (FINAL_THUMBNAIL_FAILURES as readonly string[]).includes(failure.reason)
  ) {
    return false;
  }
  return failure.attempts < MAX_THUMBNAIL_ATTEMPTS;
}

export interface ThumbnailBackfillPayload {
  userId: string;
  enqueuedAt?: string;
}

export interface ThumbnailBackfillSummary {
  enqueued: number;
}

/**
 * Enqueue thumbnail jobs for one user's not-yet-thumbnailed documents.
 * Idempotent + resumable: an already-thumbnailed document drops out of the
 * candidate set, and the pass stops at the per-run cap.
 */
export async function runThumbnailBackfillForUser(
  userId: string,
): Promise<ThumbnailBackfillSummary> {
  let enqueued = 0;
  let cursor: string | null = null;

  for (;;) {
    if (enqueued >= MAX_ENQUEUES_PER_RUN) break;
    const rows: Array<{
      id: string;
      updatedAt: Date;
      thumbnailFailure: {
        reason: string;
        attempts: number;
        failedAt: Date;
      } | null;
    }> = await prisma.inboundDocument.findMany({
      where: {
        userId,
        deletedAt: null,
        mimeType: { in: [...THUMBNAILABLE_MIMES] },
        thumbnail: { is: null },
      },
      select: {
        id: true,
        updatedAt: true,
        thumbnailFailure: {
          select: { reason: true, attempts: true, failedAt: true },
        },
      },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const { id, updatedAt, thumbnailFailure } of rows) {
      if (enqueued >= MAX_ENQUEUES_PER_RUN) break;
      if (!thumbnailRetryDue(thumbnailFailure, updatedAt)) continue;
      const { enqueued: ok } = await enqueueDocumentThumbnail(userId, id);
      if (ok) enqueued += 1;
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < PAGE_SIZE) break;
  }

  annotate({
    action: { name: "documents.thumbnail.backfill" },
    meta: { enqueued },
  });
  return { enqueued };
}

/**
 * Boot-time discovery: enqueue one per-user backfill pass for every account
 * that still holds a thumbnailable document without a preview. Coalesced by
 * `singletonKey` per user. Fire-and-forget — a missing boss is a no-op.
 */
export async function enqueueBootTimeThumbnailBackfill(): Promise<{
  enqueued: number;
}> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: 0 };

  // On a CPU the bundled Skia build cannot run on (no AVX2), thumbnail jobs
  // would only churn the queue — every generation no-ops behind the gate.
  if (!nativeCanvasSupported()) return { enqueued: 0 };

  // v1.28.46 perf (H4) — DB-level SELECT DISTINCT with an anti-join to the
  // thumbnail side table, not Prisma `distinct` (which fetches every matching
  // row then de-dupes in JS at boot). The migration-0243 partial index over
  // `(user_id, mime_type) WHERE deleted_at IS NULL` bounds the document-side
  // scan; `document_thumbnails.document_id` is already UNIQUE (the 1:1
  // relation) so the `t.id IS NULL` anti-join is index-driven.
  //
  // A document whose render failed for good is left out by the rule
  // `thumbnailRetryDue` states, so an account whose only missing previews
  // cannot be made is not queued at every boot.
  const rows = await prisma.$queryRaw<{ user_id: string }[]>`
    SELECT DISTINCT d.user_id AS user_id
    FROM inbound_documents d
    LEFT JOIN document_thumbnails t ON t.document_id = d.id
    LEFT JOIN document_thumbnail_failures f ON f.document_id = d.id
    WHERE d.deleted_at IS NULL
      AND d.mime_type IN (${Prisma.join([...THUMBNAILABLE_MIMES])})
      AND t.id IS NULL
      AND (
        f.document_id IS NULL
        OR d.updated_at > f.failed_at
        OR (
          f.reason NOT IN (${Prisma.join([...FINAL_THUMBNAIL_FAILURES])})
          AND f.attempts < ${MAX_THUMBNAIL_ATTEMPTS}
        )
      )`;

  let enqueued = 0;
  for (const { user_id: userId } of rows) {
    const payload: ThumbnailBackfillPayload = {
      userId,
      enqueuedAt: new Date().toISOString(),
    };
    try {
      const jobId = await boss.send(
        DOCUMENT_THUMBNAIL_BACKFILL_QUEUE,
        payload,
        {
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
          singletonKey: `document-thumbnail-backfill|${userId}`,
        },
      );
      if (jobId) enqueued += 1;
    } catch {
      // A transient send failure is a no-op — the next boot re-discovers the
      // still-missing thumbnails.
    }
  }

  annotate({
    action: { name: "documents.thumbnail.backfill.boot" },
    meta: { users: enqueued },
  });
  return { enqueued };
}
