/**
 * `POST /api/measurements/restore` — un-tombstone for the management
 * list's delete-Undo affordance (v1.16.4).
 *
 * Body:
 *   { ids: string[] }   — 1..200 measurement ids, scoped to the caller.
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
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import { bloodPressureSiblings } from "@/lib/measurements/blood-pressure-reading";
import type { MeasurementType } from "@/generated/prisma/client";

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
  // v1.37.0 — MANAGE. A manager who holds the delete holds the undo; the
  // `where` below only ever clears a tombstone the record already carried.
  const { user, actor } = await requireRecordAuth("manage", "measurements");

  // v1.37.0 — C1: the bucket keys on the ACTOR, the frozen precedent from
  // `medications/compliance`. A manager burns their own allowance rather than
  // locking the owner out of their own record, and cannot collect a fresh one
  // by switching records.
  const rl = await checkRateLimit(
    `measurements:restore:${actor.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many restore requests, try again later", 429);
  }

  const parsed = await parseJsonBody(request, restoreSchema, {
    maxBytes: 256 * 1024,
    errorCode: "measurement.restore.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const { ids } = parsed.data;

  // Read the soon-to-be-restored rows first so we know which
  // `(type, day)` buckets need a rollup recompute and which types need
  // a status-insight cache drop. Ownership-scoped + `deletedAt != null`
  // so a forged / foreign / never-deleted id is excluded here exactly as
  // it is from the mutation below — no existence leak.
  //
  // A blood-pressure half brings back the rows of its reading that were
  // tombstoned in the same statement (identical `deletedAt`,
  // `bloodPressureSiblings`), so an undo that names only the row the person
  // tapped restores the reading the delete took. A row deleted on its own,
  // at another moment, stays deleted.
  const { affected, count } = await prisma.$transaction(async (tx) => {
    const selected = await tx.measurement.findMany({
      where: { id: { in: ids }, userId: user.id, deletedAt: { not: null } },
      select: {
        id: true,
        type: true,
        source: true,
        measuredAt: true,
        deletedAt: true,
      },
    });
    const siblings = await bloodPressureSiblings(
      tx,
      user.id,
      selected,
      "deletedWith",
    );
    const rowIds = [...selected, ...siblings].map((row) => row.id);

    // Un-tombstone in one statement. The `where` pins `userId` so a forged
    // id for another user is silently a no-op; `deletedAt: { not: null }`
    // keeps the count honest (a live row doesn't re-count).
    const { count } = await tx.measurement.updateMany({
      where: { id: { in: rowIds }, userId: user.id, deletedAt: { not: null } },
      data: { deletedAt: null, syncVersion: { increment: 1 } },
    });
    return { affected: [...selected, ...siblings], count };
  });

  await auditLog("measurement.restore", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count },
  });

  annotate({
    action: { name: "measurement.restore" },
    meta: { count },
  });

  if (count > 0) {
    // Bust per-user analytics + achievements + workouts caches so
    // subsequent reads reflect the restored rows. Interactive undo —
    // hard-evict so the SWR readers don't serve the pre-restore body.
    invalidateUserMeasurements(user.id, { evict: true });

    // v1.37.19 — shared post-mutation tail; mirrors the
    // bulk-delete path.
    await afterMeasurementMutation(
      user.id,
      affected.map((row) => ({
        type: row.type as MeasurementType,
        measuredAt: row.measuredAt,
      })),
      { source: "manual", label: "measurements restore" },
    );
  }

  return apiSuccess({ restored: count });
}
