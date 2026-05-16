/**
 * `DELETE /api/measurements/by-external-ids` — iOS deletion reconciliation.
 *
 * HealthKit's API does not surface a stream of deleted UUIDs, so the
 * iOS client performs a periodic 30-day window reconciliation: it pulls
 * the current set of HealthKit sample UUIDs in the window and posts the
 * externalIds the server holds that are no longer present. This endpoint
 * accepts that batch-delete list and removes every matching row owned by
 * the calling user.
 *
 * Idempotency contract:
 *   - Cross-user safety: rows owned by another user are silently skipped
 *     (Prisma's `deleteMany` with `userId` in the where-clause guarantees
 *     this), so a duplicate / replayed delete is a no-op rather than a
 *     401.
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

  // Prisma `deleteMany` with the userId predicate is the cross-user
  // 404 guard: rows belonging to other users are simply not matched.
  // No need for a pre-flight findMany — the unique index on
  // `(userId, type, source, externalId)` keeps the matching set small
  // even when the user has overlapping HealthKit history.
  const result = await prisma.measurement.deleteMany({
    where: {
      userId: user.id,
      externalId: { in: externalIds },
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
  }

  return apiSuccess({ deletedCount: result.count });
}
