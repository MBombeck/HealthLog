/**
 * v1.4.25 — per-row side-effect operations.
 *
 *   DELETE /api/medications/[id]/side-effects/[logId]
 *     - hard delete; the row is user-owned, non-clinical, and the
 *       audit log captures enough state to reconstruct it if needed.
 *
 * maintainer decision (from the W19d brief): allow delete at any time
 * rather than a 24-hour retraction window. Side-effect rows are not
 * a clinical record; the user owns them and a stale mis-entry should
 * never be undeletable. The audit trail preserves "what was deleted
 * when" for any forensic reconstruction.
 */

import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";

type RouteParams = { params: Promise<{ id: string; logId: string }> };

async function loadOwnedRow(
  medicationId: string,
  logId: string,
  userId: string,
) {
  const row = await prisma.medicationSideEffect.findUnique({
    where: { id: logId },
  });
  if (!row || row.userId !== userId || row.medicationId !== medicationId) {
    return null;
  }
  return row;
}

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. The one hard delete in the tree whose audit details
    // already reconstruct the row: entry, severity and the date it happened
    // are on the row this handler writes.
    const { user } = await requireRecordAuth("manage", "medications");
    const { id, logId } = await params;

    const existing = await loadOwnedRow(id, logId, user.id);
    if (!existing) return apiError("Side-effect log not found", 404);

    await prisma.medicationSideEffect.delete({ where: { id: logId } });

    await auditLog("medication.sideEffect.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        sideEffectId: logId,
        entry: existing.entry,
        severity: existing.severity,
        occurredAt: existing.occurredAt.toISOString(),
      },
    });

    annotate({
      action: {
        name: "medication.sideEffect.delete",
        entity_type: "medication_side_effect",
        entity_id: logId,
      },
      meta: { medication_id: id },
    });

    return apiSuccess({ id: logId, deleted: true });
  },
);
