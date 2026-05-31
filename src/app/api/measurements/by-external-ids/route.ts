/**
 * `DELETE /api/measurements/by-external-ids` — iOS deletion reconciliation.
 *
 * HealthKit's API does not surface a stream of deleted UUIDs, so the
 * iOS client performs a periodic 30-day window reconciliation: it pulls
 * the current set of HealthKit sample UUIDs in the window and posts the
 * externalIds the server holds that are no longer present. This endpoint
 * accepts that batch-delete list and soft-deletes every matching row owned
 * by the calling user (v1.7.0 — sets `deletedAt` + bumps `syncVersion`
 * rather than removing the row, so deletions surface as tombstones on the
 * `/api/sync/changes` delta feed).
 *
 * Idempotency contract:
 *   - Cross-user safety: rows owned by another user are silently skipped
 *     (Prisma's `updateMany` with `userId` in the where-clause guarantees
 *     this), so a duplicate / replayed delete is a no-op rather than a
 *     401. The `deletedAt: null` guard makes a replay touch zero rows
 *     and return `deletedCount: 0`.
 *   - Empty arrays return `{ deletedCount: 0 }` with 200 — the iOS
 *     client should not consider that a failure.
 *   - The batch cap mirrors the ingest path (`/api/measurements/batch`)
 *     so the two surfaces share the same operational ceiling.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import {
  recomputeBucketsForMeasurement,
  collapseToTypeDayKeys,
} from "@/lib/rollups/measurement-rollups";

const MAX_BATCH_ENTRIES = 500;

const payloadSchema = z.object({
  externalIds: z
    .array(z.string().min(1).max(120))
    .min(0)
    .max(MAX_BATCH_ENTRIES),
});

export const DELETE = apiHandler(deleteByExternalIds);

async function deleteByExternalIds(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const { data: rawBody, error: jsonError } = await safeJson<unknown>(request);
  if (jsonError) return jsonError;

  // Distinguish "too many entries" from "validation failed" so the iOS
  // client surfaces a useful diagnostic — same shape the ingest endpoint
  // uses for its symmetric cap.
  if (
    typeof rawBody === "object" &&
    rawBody !== null &&
    "externalIds" in rawBody &&
    Array.isArray((rawBody as { externalIds: unknown }).externalIds) &&
    (rawBody as { externalIds: unknown[] }).externalIds.length >
      MAX_BATCH_ENTRIES
  ) {
    return apiError(`Batch exceeds the ${MAX_BATCH_ENTRIES}-entry limit`, 422, {
      errorCode: "measurement.delete.too_large",
    });
  }

  const parsed = payloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0]?.message ?? "Invalid batch", 422);
  }

  const { externalIds } = parsed.data;

  if (externalIds.length === 0) {
    annotate({
      action: { name: "measurement.delete.by_external_ids" },
      meta: { processed: 0, deleted: 0 },
    });
    return apiSuccess({ deletedCount: 0 });
  }

  // v1.7.0 — soft-delete instead of a hard `deleteMany`. Flipping
  // `deletedAt` (+ bumping `syncVersion`) keeps the row so the
  // `/api/sync/changes` delta feed surfaces it as a tombstone keyed on
  // `externalId` for paired clients that were offline at delete time.
  // Every list / analytics / rollup read already filters
  // `deletedAt: null`, so a tombstoned row is invisible to normal reads.
  //
  // The userId predicate stays the cross-user 404 guard: rows belonging
  // to other users are simply not matched. The `deletedAt: null` guard
  // makes a replayed reconciliation idempotent — already-tombstoned rows
  // are not re-touched and `deletedCount` counts only rows newly
  // tombstoned by this call. We pre-fetch the (type, measuredAt) tuples
  // of the live matches so the rollup recompute below knows which
  // buckets to refresh.
  const affectedRows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      externalId: { in: externalIds },
      deletedAt: null,
    },
    select: { type: true, measuredAt: true },
  });

  const result = await prisma.measurement.updateMany({
    where: {
      userId: user.id,
      externalId: { in: externalIds },
      deletedAt: null,
    },
    data: {
      deletedAt: new Date(),
      syncVersion: { increment: 1 },
    },
  });

  await auditLog("measurement.delete.by_external_ids", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { processed: externalIds.length, deleted: result.count },
  });

  annotate({
    action: { name: "measurement.delete.by_external_ids" },
    meta: { processed: externalIds.length, deleted: result.count },
  });

  // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
  // caches when at least one row deleted so the next read reflects the
  // reconciliation. A 0-delete batch is a no-op and skips the eviction.
  if (result.count > 0) {
    invalidateUserMeasurements(user.id);

    // v1.5.0 — refresh the rollup row for every distinct (type, day)
    // tuple the deletion touched. Collapsed by day so the same
    // morning's deletes fold into one recompute per type. Best-
    // effort — a populator hiccup never fails the user's reconciliation.
    try {
      const keys = collapseToTypeDayKeys(affectedRows);
      for (const k of keys) {
        await recomputeBucketsForMeasurement(user.id, k.type, k.measuredAt);
      }
    } catch (err) {
      console.warn("[measurements] rollup recompute failed", err);
    }
  }

  return apiSuccess({ deletedCount: result.count });
}
