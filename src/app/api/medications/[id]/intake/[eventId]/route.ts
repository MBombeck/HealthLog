import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { updateIntakeEventSchema } from "@/lib/validations/medication";
import {
  findEditableIntakeEvent,
  updateIntakeEvent,
} from "@/lib/medications/update-intake-event";
import {
  deleteIntakeEvent,
  findDeletableIntakeEvent,
} from "@/lib/medications/delete-intake-event";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string; eventId: string }> };

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Correcting a dose tombstones the original and
    // re-creates it on the corrected slot, so the write is reconstructable by
    // the rows; what it must not do is restamp where the dose came from (C8).
    const { user } = await requireRecordAuth("manage", "medications");

    const { id, eventId } = await params;

    const event = await findEditableIntakeEvent({
      userId: user.id,
      medicationId: id,
      eventId,
    });
    if (!event) {
      return apiError("Intake not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });

    if (jsonError) return jsonError;
    const parsed = updateIntakeEventSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 — per-event update hot path; multi-issue 422 +
      // audit breadcrumb keyed
      // `medications.intake.event.update.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "medications.intake.event.update.validation-failed" },
        meta: {
          issue_count: issues.length,
          medication_id: id,
          event_id: eventId,
        },
      });
      // v1.37.0 — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only writer that stamps
      // `actorUserId`. Filed under the resolved record either way; without the
      // stamp a manager's malformed payload would read as the owner's own.
      void auditLog("medications.intake.event.update.validation-failed", {
        userId: user.id,
        details: {
          issues,
          medicationId: id,
          eventId,
        },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422);
    }

    const outcome = await updateIntakeEvent({
      user,
      medicationId: id,
      eventId,
      event,
      data: parsed.data,
      ipAddress: getClientIp(request),
      originDeviceToken: request.headers.get("x-device-id"),
    });
    if (!outcome.ok) {
      return apiError(outcome.message, 422, { errorCode: outcome.errorCode });
    }

    return apiSuccess(outcome.row);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    // v1.37.0 — MANAGE. Soft delete: the row stays, the sync feed carries the
    // tombstone, and the inventory stamp is refunded.
    const { user } = await requireRecordAuth("manage", "medications");

    const { id, eventId } = await params;

    const event = await findDeletableIntakeEvent({
      userId: user.id,
      medicationId: id,
      eventId,
    });
    if (!event) {
      return apiError("Intake not found", 404);
    }

    await deleteIntakeEvent({
      user,
      medicationId: id,
      eventId,
      event,
      ipAddress: getClientIp(request) ?? "unknown",
      originDeviceToken: request.headers.get("x-device-id"),
    });

    return apiSuccess({ deleted: true });
  },
);
