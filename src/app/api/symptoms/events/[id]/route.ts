/**
 * One occurrence of a person-defined symptom (v1.40).
 *
 *   PATCH  /api/symptoms/events/{id} — change the time, intensity, note or
 *          episode link. A new link must name an episode of the record that
 *          is open or ran over the occurrence's time; an unchanged link to an
 *          episode that has since resolved is kept.
 *   DELETE /api/symptoms/events/{id} — remove it.
 *
 * Owner-scoped (another account's id is a 404), module-gated on the record,
 * MANAGE on a shared record. The note is never logged.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  destroyedDetails,
  overwriteDetails,
} from "@/lib/sharing/audit-details";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import {
  encryptSymptomText,
  isLinkableEpisode,
  symptomEventUpdateSchema,
  toSymptomEventDTO,
} from "@/lib/symptoms/server";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function notFound(): Response {
  return apiError("Symptom event not found", 404, {
    errorCode: "symptoms.event.notFound",
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const parsed = await parseJsonBody(request, symptomEventUpdateSchema, {
      maxBytes: 16 * 1024,
      errorCode: "symptoms.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const entry = parsed.data;

    const existing = await prisma.symptomEvent.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        occurredAt: true,
        intensity: true,
        episodeId: true,
      },
    });
    if (!existing) return notFound();

    // A new link is checked against the time the occurrence will have after
    // this edit, so moving it and filing it in one save is judged as a whole.
    if (
      entry.episodeId &&
      entry.episodeId !== existing.episodeId &&
      !(await isLinkableEpisode(
        user.id,
        entry.episodeId,
        entry.occurredAt ?? existing.occurredAt,
      ))
    ) {
      return apiError("Episode did not run at that time", 422, {
        errorCode: "symptoms.episode.notOpen",
      });
    }

    const updated = await prisma.symptomEvent.update({
      where: { id: existing.id },
      data: {
        ...(entry.occurredAt !== undefined
          ? { occurredAt: entry.occurredAt }
          : {}),
        ...(entry.intensity !== undefined
          ? { intensity: entry.intensity }
          : {}),
        ...(entry.note !== undefined
          ? {
              noteEncrypted: entry.note ? encryptSymptomText(entry.note) : null,
            }
          : {}),
        ...(entry.episodeId !== undefined
          ? { episodeId: entry.episodeId ?? null }
          : {}),
      },
    });

    await auditLog("symptoms.event.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        eventId: id,
        ...overwriteDetails({
          before: {
            occurredAt: existing.occurredAt,
            intensity: existing.intensity,
            episodeId: existing.episodeId,
          },
          after: {
            occurredAt: updated.occurredAt,
            intensity: updated.intensity,
            episodeId: updated.episodeId,
          },
          redacted: entry.note !== undefined ? ["note"] : [],
        }),
      },
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "symptoms.event.update",
        entity_type: "symptom_event",
        entity_id: id,
      },
    });

    return apiSuccess(toSymptomEventDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const existing = await prisma.symptomEvent.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        definitionId: true,
        occurredAt: true,
        intensity: true,
      },
    });
    if (!existing) return notFound();

    await prisma.symptomEvent.delete({ where: { id: existing.id } });

    await auditLog("symptoms.event.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C3: the row is gone after this; the audit row says what it was. The
      // symptom's name is the person's own words and stays out of it, so the
      // label is the definition id.
      details: destroyedDetails({
        model: "SymptomEvent",
        id,
        label: existing.definitionId,
        effectiveAt: existing.occurredAt,
        extra: { intensity: existing.intensity },
      }),
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "symptoms.event.delete",
        entity_type: "symptom_event",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
