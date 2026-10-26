/**
 * `POST /api/mood-entries/restore` — un-tombstone for the mood list's
 * delete-Undo affordance (v1.16.4).
 *
 * Body:
 *   { ids: string[] }   — 1..200 mood-entry ids, scoped to the caller.
 *
 * Clears `deletedAt` (+ bumps `syncVersion`) on every owned,
 * currently-tombstoned row in one `updateMany`, so the row re-surfaces
 * in normal reads and the `/api/sync/changes` delta feed carries it as
 * an upsert to paired clients. A forged / foreign / not-deleted id is a
 * silent no-op (never a 404 existence leak): the mutation `where` pins
 * `userId` so it only ever touches the caller's rows.
 *
 * Response (200):
 *   { restored: <number of rows un-tombstoned> }
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

const restoreSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(MAX_IDS_PER_BATCH),
  })
  .strict();

export const POST = apiHandler(withIdempotency<[NextRequest]>(postRestore));

async function postRestore(request: NextRequest): Promise<Response> {
  // v1.37.0 — MANAGE. The undo beside a delete the level admits; the `where` only ever
  // clears a tombstone the record already carried.
  const { user, actor } = await requireRecordAuth("manage", "mind");

  // v1.37.0 — C1: the bucket keys on the ACTOR, the frozen precedent from
  // `medications/compliance`. A manager burns their own allowance rather than
  // locking the owner out of their own record, and cannot collect a fresh one
  // by switching records.
  const rl = await checkRateLimit(
    `mood-entries:restore:${actor.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many restore requests, try again later", 429);
  }

  const parsed = await parseJsonBody(request, restoreSchema, {
    maxBytes: 256 * 1024,
    errorCode: "mood.restore.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const { ids } = parsed.data;

  // Read the soon-to-be-restored rows first so we know which days need
  // a mood-rollup recompute. Ownership-scoped + `deletedAt != null` so a
  // forged / foreign / never-deleted id is excluded here exactly as it
  // is from the mutation below — no existence leak.
  const affected = await prisma.moodEntry.findMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: { not: null } },
    select: { date: true },
  });

  // Un-tombstone in one statement. The `where` pins `userId` so a forged
  // id for another user is silently a no-op; `deletedAt: { not: null }`
  // keeps the count honest (a live row doesn't re-count).
  const { count } = await prisma.moodEntry.updateMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: { not: null } },
    data: { deletedAt: null, syncVersion: { increment: 1 } },
  });

  await auditLog("mood.restore", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count },
  });

  annotate({
    action: { name: "mood.restore" },
    meta: { count },
  });

  if (count > 0) {
    // Bust per-user mood + achievements + analytics caches.
    invalidateUserMood(user.id);

    // v1.32.12 — collapse the restored rows to the unique set of `date`
    // labels BEFORE recomputing — mirrors the bulk-delete path and keys
    // byte-identically to the stored `MoodEntry.date`. Best-effort: a
    // populator hiccup never fails the user's restore.
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

  return apiSuccess({ restored: count });
}
