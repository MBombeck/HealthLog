/**
 * `POST /api/mood-entries/bulk-delete` — multi-select soft-delete for the
 * mood management list (v1.15.13).
 *
 * Body:
 *   { ids: string[] }   — 1..200 mood-entry ids, scoped to the caller.
 *
 * Soft-deletes (tombstones) every owned, not-already-deleted row in one
 * `updateMany` — matching the single-DELETE iOS tombstone contract. A
 * forged / foreign id is a silent no-op (never a 404 existence leak): the
 * mutation `where` pins `userId` so it only ever touches the caller's rows.
 *
 * Response (200):
 *   { deleted: <number of rows tombstoned> }
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { withIdempotency } from "@/lib/idempotency";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";

const MAX_IDS_PER_BATCH = 200;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

const bulkDeleteSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(MAX_IDS_PER_BATCH),
  })
  .strict();

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBulkDelete));

async function postBulkDelete(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. Tombstoning a selection; every row stays and `mood-entries/restore`
  // puts it back.
  const { user, actor } = await requireRecordAuth("manage", "mind");

  // v1.37.0 — C1: the bucket keys on the ACTOR, the frozen precedent from
  // `medications/compliance`. A manager burns their own allowance rather than
  // locking the owner out of their own record, and cannot collect a fresh one
  // by switching records.
  const rl = await checkRateLimit(
    `mood-entries:bulk-delete:${actor.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many bulk deletions, try again later", 429);
  }

  const parsed = await parseJsonBody(request, bulkDeleteSchema, {
    maxBytes: 256 * 1024,
    errorCode: "mood.bulk-delete.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const { ids } = parsed.data;
  const now = new Date();

  // Read the soon-to-be-tombstoned rows first so we know which days need
  // a mood-rollup recompute. Ownership-scoped + `deletedAt: null` so a
  // forged / foreign / already-tombstoned id is excluded here exactly as
  // it is from the mutation below — no existence leak.
  const affected = await prisma.moodEntry.findMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: null },
    select: { date: true },
  });

  // Soft-delete (tombstone) in one statement. The `where` pins `userId`
  // so a forged id for another user is silently a no-op; `deletedAt: null`
  // keeps the count honest (an already-tombstoned id doesn't re-count).
  const { count } = await prisma.moodEntry.updateMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: null },
    data: { deletedAt: now, syncVersion: { increment: 1 } },
  });

  await auditLog("mood.delete.bulk", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count },
  });

  annotate({
    action: { name: "mood.delete.bulk" },
    meta: { count },
  });

  if (count > 0) {
    // v1.4.34 — bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.32.12 — collapse the deleted rows to the unique set of `date`
    // labels BEFORE recomputing so a bulk delete spanning one local day
    // fires one recompute, not one per row, and keys byte-identically to
    // the stored `MoodEntry.date`. Best-effort — a populator hiccup
    // never fails the user's delete.
    const touchedLabels = new Set<string>();
    for (const row of affected) {
      touchedLabels.add(row.date);
    }
    try {
      await Promise.all(
        Array.from(touchedLabels).map((label) =>
          recomputeMoodBucketsForEntry(user.id, label),
        ),
      );
    } catch (rollupErr) {
      annotate({
        meta: {
          mood_rollup_write_failed: true,
          mood_rollup_write_error:
            rollupErr instanceof Error ? rollupErr.message : String(rollupErr),
        },
      });
    }
  }

  return apiSuccess({ deleted: count });
}
