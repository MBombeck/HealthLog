/**
 * One rescue dose (#1368).
 *
 *   PATCH  /api/seizures/events/{id}/rescue/{doseId} — record whether it
 *          worked and when the seizure ended, or correct who gave it and how.
 *   DELETE /api/seizures/events/{id}/rescue/{doseId} — remove it, and undo
 *          the intake it wrote on the medication.
 *
 * MANAGE on a shared record; module-gated; owner-scoped.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { requireSeizuresEnabled } from "@/lib/seizures/gate";
import {
  seizureRescueDoseUpdateSchema,
  toSeizureRescueDoseDTO,
} from "@/lib/seizures/server";
import { undoRescueIntakes } from "@/lib/seizures/rescue";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; doseId: string }> };

function notFound(): Response {
  return apiError("Rescue dose not found", 404, {
    errorCode: "seizures.rescue.notFound",
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireSeizuresEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id, doseId } = await params;
    const parsed = await parseJsonBody(request, seizureRescueDoseUpdateSchema, {
      maxBytes: 8 * 1024,
      errorCode: "seizures.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const d = parsed.data;

    const existing = await prisma.seizureRescueDose.findFirst({
      where: { id: doseId, eventId: id, userId: user.id },
      select: {
        id: true,
        effect: true,
        seizureEndedAt: true,
        givenBy: true,
        route: true,
      },
    });
    if (!existing) return notFound();

    const updated = await prisma.seizureRescueDose.update({
      where: { id: existing.id },
      data: {
        ...(d.effect !== undefined ? { effect: d.effect } : {}),
        ...(d.seizureEndedAt !== undefined
          ? { seizureEndedAt: d.seizureEndedAt ?? null }
          : {}),
        ...(d.givenBy !== undefined ? { givenBy: d.givenBy ?? null } : {}),
        ...(d.route !== undefined ? { route: d.route ?? null } : {}),
      },
    });

    await auditLog("seizures.rescue.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        eventId: id,
        doseId,
        ...overwriteDetails({
          before: {
            effect: existing.effect,
            seizureEndedAt: existing.seizureEndedAt,
            givenBy: existing.givenBy,
            route: existing.route,
          },
          after: {
            effect: updated.effect,
            seizureEndedAt: updated.seizureEndedAt,
            givenBy: updated.givenBy,
            route: updated.route,
          },
        }),
      },
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "seizures.rescue.update",
        entity_type: "seizure_rescue_dose",
        entity_id: doseId,
      },
    });

    return apiSuccess(toSeizureRescueDoseDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireSeizuresEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id, doseId } = await params;
    const existing = await prisma.seizureRescueDose.findFirst({
      where: { id: doseId, eventId: id, userId: user.id },
      select: {
        id: true,
        givenAt: true,
        medicationId: true,
        intakeEventId: true,
      },
    });
    if (!existing) return notFound();

    const undone = await undoRescueIntakes(
      user,
      [existing],
      getClientIp(request),
      request.headers.get("x-device-id"),
    );
    await prisma.seizureRescueDose.delete({ where: { id: existing.id } });

    await auditLog("seizures.rescue.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: destroyedDetails({
        model: "SeizureRescueDose",
        id: doseId,
        label: existing.medicationId ?? "unlinked",
        effectiveAt: existing.givenAt,
        extra: { eventId: id, intakesUndone: undone },
      }),
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "seizures.rescue.delete",
        entity_type: "seizure_rescue_dose",
        entity_id: doseId,
      },
      meta: { intakes_undone: undone },
    });

    return apiSuccess({ deleted: true });
  },
);
