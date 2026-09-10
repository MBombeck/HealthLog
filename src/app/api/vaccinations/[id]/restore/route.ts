/**
 * `POST /api/vaccinations/{id}/restore` — clear a dose's tombstone.
 *
 * MANAGE rather than WRITE: undoing a deletion is a management act when the
 * manager is the one who holds delete.
 *
 * The document links survived the soft delete — they cascade only on a hard
 * one — so a restored dose comes back with the page it was transcribed from
 * still filed against it. The booster satisfy matcher does not run: restoring
 * is not logging a dose, and the reminder it once satisfied was never rewound
 * by the deletion either.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { toVaccinationDTO } from "@/lib/vaccinations/dto";
import {
  VACCINATION_INCLUDE,
  loadVaccinationDocuments,
  resolveSeriesFor,
} from "@/lib/vaccinations/service";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("manage", "profile");

    const { id } = await params;
    const existing = await prisma.vaccinationRecord.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== user.id) {
      return apiError("Vaccination not found", 404);
    }

    if (existing.deletedAt !== null) {
      await prisma.vaccinationRecord.update({
        where: { id },
        data: { deletedAt: null },
      });
    }

    const row = await prisma.vaccinationRecord.findUniqueOrThrow({
      where: { id },
      include: VACCINATION_INCLUDE,
    });
    const visible = await actingDomainVisibility(prisma, grantId);
    const [documents, series] = await Promise.all([
      loadVaccinationDocuments(prisma, user.id, id, visible),
      resolveSeriesFor(prisma, user.id),
    ]);

    await auditLog("vaccination.record.restore", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { vaccinationId: id, occurredAt: row.occurredAt.toISOString() },
    });

    annotate({
      action: {
        name: "vaccination.record.restore",
        entity_type: "vaccination",
        entity_id: id,
      },
    });

    return apiSuccess(toVaccinationDTO(row, series.get(id) ?? [], documents));
  },
);
