/**
 * `POST /api/custom-metrics/{id}/entries/restore` — un-tombstone for the
 * entry delete-Undo affordance (v1.37.20, A3-11).
 *
 * Body: `{ ids: string[] }` — 1..200 entry ids, scoped to the caller and the
 * parent metric.
 *
 * Clears `deletedAt` on every owned, currently-tombstoned row of THIS metric
 * in one `updateMany`, so the value re-surfaces in normal reads. A forged /
 * foreign / live / mismatched-parent id is a silent no-op (never a 404
 * existence leak): the mutation `where` pins `userId` and `customMetricId`,
 * so it only ever touches the caller's rows. Mirrors `/api/labs/restore`.
 * Same session auth as the delete beside it — custom-metric entry writes are
 * not delegable.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { invalidateUserCorrelationPatterns } from "@/lib/cache/invalidate";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

const MAX_IDS_PER_BATCH = 200;

const restoreSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(MAX_IDS_PER_BATCH),
  })
  .strict();

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const parsed = await parseJsonBody(request, restoreSchema, {
      maxBytes: 64 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const { count } = await prisma.customMetricEntry.updateMany({
      where: {
        id: { in: parsed.data.ids },
        userId: user.id,
        customMetricId: id,
        deletedAt: { not: null },
      },
      data: { deletedAt: null },
    });

    if (count > 0) invalidateUserCorrelationPatterns(user.id);

    await auditLog("customMetricEntry.restore", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { customMetricId: id, restored: count },
    });

    annotate({
      action: { name: "custom-metric.entry.restore" },
      meta: { customMetricId: id, restored: count },
    });

    return apiSuccess({ restored: count });
  },
);
