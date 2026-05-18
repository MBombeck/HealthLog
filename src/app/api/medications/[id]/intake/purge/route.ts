import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    const medication = await prisma.medication.findUnique({ where: { id } });
    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    const { count } = await prisma.medicationIntakeEvent.deleteMany({
      where: { medicationId: id, userId: user.id },
    });

    // v1.4.39 W-MED — drop every rollup row for this medication so the
    // next compliance read returns zero-filled buckets rather than the
    // last-known scheduled / taken totals for now-deleted events.
    await prisma.medicationComplianceRollup.deleteMany({
      where: { medicationId: id, userId: user.id },
    });

    await auditLog("medication.intake.purge", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, name: medication.name, deletedCount: count },
    });

    annotate({
      action: {
        name: "medication.intake.purge",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { purged_count: count },
    });

    return apiSuccess({ purged: true, count });
  },
);
