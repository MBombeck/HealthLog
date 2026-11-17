/**
 * One recorded seizure (#1368).
 *
 *   PATCH  /api/seizures/events/{id} — add the details later, or correct
 *          them. An absent field is left alone; `null` (or an empty string
 *          for text) clears it.
 *   DELETE /api/seizures/events/{id} — remove it with its rescue doses, and
 *          undo the intakes those doses wrote on the medication.
 *
 * Owner-scoped (another record's id is a 404), module-gated, MANAGE on a
 * shared record. Free text is never logged.
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
  listSeizureTypes,
  sealOptional,
  seizureEventUpdateSchema,
  toSeizureEventDTO,
  typeLookupOf,
} from "@/lib/seizures/server";
import { undoRescueIntakes } from "@/lib/seizures/rescue";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function notFound(): Response {
  return apiError("Seizure not found", 404, {
    errorCode: "seizures.event.notFound",
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("manage", "illness");

    const gate = await requireSeizuresEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const parsed = await parseJsonBody(request, seizureEventUpdateSchema, {
      maxBytes: 64 * 1024,
      errorCode: "seizures.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const e = parsed.data;

    const existing = await prisma.seizureEvent.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        onsetAt: true,
        durationSec: true,
        durationSource: true,
        count: true,
        certainty: true,
        typeProfileId: true,
      },
    });
    if (!existing) return notFound();

    const types = await listSeizureTypes(user.id);
    if (e.typeProfileId && !types.some((t) => t.id === e.typeProfileId)) {
      return apiError("Seizure type not found", 404, {
        errorCode: "seizures.type.notFound",
      });
    }

    const updated = await prisma.seizureEvent.update({
      where: { id: existing.id },
      data: {
        ...(e.typeProfileId !== undefined
          ? { typeProfileId: e.typeProfileId ?? null }
          : {}),
        ...(e.ilaeType !== undefined ? { ilaeType: e.ilaeType ?? null } : {}),
        ...(e.onsetAt !== undefined ? { onsetAt: e.onsetAt } : {}),
        ...(e.onsetPrecision !== undefined
          ? { onsetPrecision: e.onsetPrecision }
          : {}),
        ...(e.durationSec !== undefined
          ? { durationSec: e.durationSec ?? null }
          : {}),
        ...(e.durationSource !== undefined
          ? { durationSource: e.durationSource }
          : e.durationSec === null
            ? { durationSource: "UNKNOWN" as const }
            : // A duration added to one nobody timed is an estimate.
              typeof e.durationSec === "number" &&
                existing.durationSource === "UNKNOWN"
              ? { durationSource: "ESTIMATED" as const }
              : {}),
        ...(e.count !== undefined ? { count: e.count } : {}),
        ...(e.certainty !== undefined ? { certainty: e.certainty } : {}),
        ...(e.sleepState !== undefined ? { sleepState: e.sleepState } : {}),
        ...(e.observableManifestations !== undefined
          ? { observableManifestations: e.observableManifestations ?? null }
          : {}),
        ...(e.responsiveness !== undefined
          ? { responsiveness: e.responsiveness ?? null }
          : {}),
        ...(e.recall !== undefined ? { recall: e.recall ?? null } : {}),
        ...(e.semiology !== undefined ? { semiology: e.semiology } : {}),
        ...(e.semiologyNote !== undefined
          ? { semiologyNoteEncrypted: sealOptional(e.semiologyNote) }
          : {}),
        ...(e.aura !== undefined
          ? { auraEncrypted: sealOptional(e.aura) }
          : {}),
        ...(e.triggers !== undefined ? { triggers: e.triggers } : {}),
        ...(e.postictalMinutes !== undefined
          ? { postictalMinutes: e.postictalMinutes ?? null }
          : {}),
        ...(e.postictal !== undefined ? { postictal: e.postictal } : {}),
        ...(e.injuries !== undefined ? { injuries: e.injuries } : {}),
        ...(e.incontinence !== undefined
          ? { incontinence: e.incontinence ?? null }
          : {}),
        ...(e.emergency !== undefined ? { emergency: e.emergency } : {}),
        ...(e.witnessed !== undefined
          ? { witnessed: e.witnessed ?? null }
          : {}),
        ...(e.witnessRole !== undefined
          ? { witnessRole: e.witnessRole ?? null }
          : {}),
        ...(e.witnessNote !== undefined
          ? { witnessNoteEncrypted: sealOptional(e.witnessNote) }
          : {}),
        ...(e.source !== undefined ? { source: e.source } : {}),
        ...(e.note !== undefined
          ? { noteEncrypted: sealOptional(e.note) }
          : {}),
      },
      include: { rescueDoses: true },
    });

    const redacted = (
      ["semiologyNote", "aura", "witnessNote", "note"] as const
    ).filter((k) => e[k] !== undefined);
    await auditLog("seizures.event.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        eventId: id,
        ...overwriteDetails({
          before: {
            onsetAt: existing.onsetAt,
            durationSec: existing.durationSec,
            count: existing.count,
            certainty: existing.certainty,
            typeProfileId: existing.typeProfileId,
          },
          after: {
            onsetAt: updated.onsetAt,
            durationSec: updated.durationSec,
            count: updated.count,
            certainty: updated.certainty,
            typeProfileId: updated.typeProfileId,
          },
          redacted: [...redacted],
        }),
      },
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "seizures.event.update",
        entity_type: "seizure_event",
        entity_id: id,
      },
    });

    return apiSuccess(
      toSeizureEventDTO(updated, typeLookupOf(types), actor.id),
    );
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireSeizuresEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const existing = await prisma.seizureEvent.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        onsetAt: true,
        count: true,
        typeProfileId: true,
        rescueDoses: { select: { medicationId: true, intakeEventId: true } },
      },
    });
    if (!existing) return notFound();

    const undone = await undoRescueIntakes(
      user,
      existing.rescueDoses,
      getClientIp(request),
      request.headers.get("x-device-id"),
    );
    await prisma.seizureEvent.delete({ where: { id: existing.id } });

    await auditLog("seizures.event.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // The row is gone after this; the audit row says what it was. The
      // type's name is the family's own words, so the label is its id.
      details: destroyedDetails({
        model: "SeizureEvent",
        id,
        label: existing.typeProfileId ?? "untyped",
        effectiveAt: existing.onsetAt,
        extra: {
          count: existing.count,
          rescueDoses: existing.rescueDoses.length,
          intakesUndone: undone,
        },
      }),
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "seizures.event.delete",
        entity_type: "seizure_event",
        entity_id: id,
      },
      meta: { intakes_undone: undone },
    });

    return apiSuccess({ deleted: true });
  },
);
