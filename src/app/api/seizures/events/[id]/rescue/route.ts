/**
 * Add a rescue dose to a recorded seizure (#1368).
 *
 *   POST /api/seizures/events/{id}/rescue — the dose, when it was given and
 *        by whom. A dose that names a medication (it must be one of the
 *        record's as-needed medications) also writes an intake on it, so the
 *        medication's history and inventory see it; an as-needed medication
 *        is never counted in compliance.
 *
 * WRITE on a shared record, like the seizure itself; changing or removing a
 * dose is MANAGE. Module-gated. Idempotent per `Idempotency-Key`.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { requireSeizuresEnabled } from "@/lib/seizures/gate";
import {
  checkRescueMedication,
  seizureRescueDoseCreateSchema,
  toSeizureRescueDoseDTO,
  writeRescueDose,
} from "@/lib/seizures/server";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postRescue),
);

async function postRescue(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { user, actor, authMethod } = await requireRecordAuth(
    "write",
    "illness",
  );

  const gate = await requireSeizuresEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const { id } = await params;
  const parsed = await parseJsonBody(request, seizureRescueDoseCreateSchema, {
    maxBytes: 16 * 1024,
    errorCode: "seizures.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const dose = parsed.data;

  const event = await prisma.seizureEvent.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!event) {
    return apiError("Seizure not found", 404, {
      errorCode: "seizures.event.notFound",
    });
  }

  let medication: { id: string; name: string } | null = null;
  if (dose.medicationId) {
    const check = await checkRescueMedication(user.id, dose.medicationId);
    if (!check.ok) {
      return apiError(check.message, check.status, {
        errorCode: check.errorCode,
      });
    }
    medication = check.medication;
  } else if (!dose.medicationName) {
    return apiError("A rescue dose needs a medication", 422, {
      errorCode: "seizures.rescue.medicationRequired",
    });
  }

  const created = await writeRescueDose(
    {
      user,
      actorId: actor.id,
      intakeSource: authMethod === "bearer" ? "API" : "WEB",
      ipAddress: getClientIp(request),
      originDeviceToken: request.headers.get("x-device-id"),
    },
    event.id,
    dose,
    medication,
  );

  await auditLog("seizures.rescue.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      eventId: event.id,
      doseId: created.id,
      medicationId: created.medicationId,
      intakeWritten: created.intakeEventId !== null,
    },
  });

  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "seizures.rescue.create",
      entity_type: "seizure_rescue_dose",
      entity_id: created.id,
    },
    meta: { intake_written: created.intakeEventId !== null },
  });

  return apiSuccess(toSeizureRescueDoseDTO(created), 201);
}
