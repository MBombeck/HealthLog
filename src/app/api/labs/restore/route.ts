/**
 * `POST /api/labs/restore` — un-tombstone for the lab-history delete-Undo
 * affordance (v1.18.1).
 *
 * Body: `{ ids: string[] }` — 1..200 lab-result ids, scoped to the caller.
 *
 * Clears `deletedAt` on every owned, currently-tombstoned row in one
 * `updateMany`, so the reading re-surfaces in normal reads. A forged /
 * foreign / not-deleted id is a silent no-op (never a 404 existence leak):
 * the mutation `where` pins `userId` so it only ever touches the caller's
 * rows. Mirrors `/api/measurements/restore`.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { checkRateLimit } from "@/lib/rate-limit";

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
  // v1.37.0 — MANAGE. The undo beside a delete the level already admits; the
  // `where` only ever clears a tombstone the record already carried, so a
  // foreign or live id is a no-op.
  const { user, actor } = await requireRecordAuth("manage", "labs");

  // v1.37.0 — C1: the bucket keys on the ACTOR, the frozen precedent from
  // `medications/compliance`. A manager burns their own allowance rather than
  // locking the owner out of their own record, and cannot collect a fresh one
  // by switching records.
  const rl = await checkRateLimit(
    `labs:restore:${actor.id}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many restore requests, try again later", 429);
  }

  const parsed = await parseJsonBody(request, restoreSchema, {
    maxBytes: 64 * 1024,
    errorCode: "labs.restore.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const { ids } = parsed.data;

  // `userId`-scoped + `deletedAt != null`: a foreign / live id is skipped.
  const { count } = await prisma.labResult.updateMany({
    where: { id: { in: ids }, userId: user.id, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
  if (count > 0) invalidateUserHealthScore(user.id);

  // Bringing a reading back is a health-data write and earns the same durable
  // row its delete already writes (`labResult.delete`). Without this the trail
  // showed a deletion that appeared to be reversed by nobody. Mirrors
  // `measurement.restore`, which is the same affordance one domain over.
  await auditLog("labResult.restore", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { count },
  });

  annotate({ action: { name: "labs.restore" }, meta: { restored: count } });

  return apiSuccess({ restored: count });
}
