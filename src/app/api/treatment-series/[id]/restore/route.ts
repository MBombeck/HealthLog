/**
 * `POST /api/treatment-series/{id}/restore` — undo a delete.
 *
 * The sessions never lost their `seriesId`, so clearing the tombstone is the
 * whole restore: every visit names the series again on the next read.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { resolveOwnerNotificationContext } from "@/lib/encounters/service";
import { actingDomainVisibility } from "@/lib/sharing/acting-domains";
import {
  TREATMENT_SERIES_INCLUDE,
  toTreatmentSeriesDTOs,
} from "@/lib/treatment-series/service";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, grantId } = await requireRecordAuth("manage", "profile");
    const { id } = await params;
    const existing = await prisma.treatmentSeries.findUnique({ where: { id } });
    if (!existing || existing.userId !== user.id) {
      return apiError("Treatment series not found", 404);
    }
    const row = await prisma.treatmentSeries.update({
      where: { id },
      data: { deletedAt: null },
      include: TREATMENT_SERIES_INCLUDE,
    });

    await auditLog("treatment-series.restore", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { seriesId: id },
    });
    invalidateUserHealthContext(user.id);
    annotate({
      action: {
        name: "treatment-series.restore",
        entity_type: "treatment_series",
        entity_id: id,
      },
    });

    const [{ timezone }, visible] = await Promise.all([
      resolveOwnerNotificationContext(user.id),
      actingDomainVisibility(prisma, grantId),
    ]);
    const [dto] = await toTreatmentSeriesDTOs(prisma, user.id, [row], {
      timezone,
      illnessVisible: visible("illness"),
    });
    return apiSuccess(dto);
  },
);
