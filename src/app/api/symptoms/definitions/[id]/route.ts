/**
 * One person-defined symptom (v1.40).
 *
 *   PATCH  /api/symptoms/definitions/{id} — rename, change the icon, reorder,
 *          hide or show again. Showing a hidden one re-clears the cap.
 *   DELETE /api/symptoms/definitions/{id} — hide by default (history kept);
 *          `?purge=true` deletes the definition and every event of it.
 *
 * Owner-scoped: another account's id is a 404. Module-gated on the record.
 * The label is never logged.
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
import { checkRateLimit } from "@/lib/rate-limit";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import {
  encryptSymptomText,
  symptomDefinitionUpdateSchema,
  toSymptomDefinitionDTO,
  MAX_ACTIVE_SYMPTOM_DEFINITIONS,
} from "@/lib/symptoms/server";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function notFound(): Response {
  return apiError("Symptom not found", 404, {
    errorCode: "symptoms.definition.notFound",
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `symptoms:definition:${actor.id}`,
      30,
      60_000,
    );
    if (!rl.allowed) {
      return apiError("Too many requests, try again later", 429);
    }

    const { id } = await params;
    const parsed = await parseJsonBody(request, symptomDefinitionUpdateSchema, {
      maxBytes: 16 * 1024,
      errorCode: "symptoms.invalid",
    });
    if (!parsed.ok) return parsed.error;

    const existing = await prisma.symptomDefinition.findFirst({
      where: { id, userId: user.id },
      select: { id: true, icon: true, isActive: true, sortOrder: true },
    });
    if (!existing) return notFound();

    // A hidden definition does not hold a slot; showing it again takes one.
    if (parsed.data.isActive === true && !existing.isActive) {
      const activeCount = await prisma.symptomDefinition.count({
        where: { userId: user.id, isActive: true },
      });
      if (activeCount >= MAX_ACTIVE_SYMPTOM_DEFINITIONS) {
        return apiError(
          `Symptom limit reached (${MAX_ACTIVE_SYMPTOM_DEFINITIONS})`,
          422,
          {
            errorCode: "symptoms.definition.limitReached",
            limit: MAX_ACTIVE_SYMPTOM_DEFINITIONS,
          },
        );
      }
    }

    const updated = await prisma.symptomDefinition.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.label !== undefined
          ? { labelEncrypted: encryptSymptomText(parsed.data.label) }
          : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.isActive !== undefined
          ? { isActive: parsed.data.isActive }
          : {}),
        ...(parsed.data.sortOrder !== undefined
          ? { sortOrder: parsed.data.sortOrder }
          : {}),
      },
      select: {
        id: true,
        labelEncrypted: true,
        icon: true,
        sortOrder: true,
        isActive: true,
      },
    });

    await auditLog("symptoms.definition.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        definitionId: id,
        ...overwriteDetails({
          before: {
            icon: existing.icon,
            isActive: existing.isActive,
            sortOrder: existing.sortOrder,
          },
          after: {
            icon: updated.icon,
            isActive: updated.isActive,
            sortOrder: updated.sortOrder,
          },
          redacted: parsed.data.label !== undefined ? ["label"] : [],
        }),
      },
    });

    // Hiding or showing one changes the correlation channel set and the
    // Coach's symptom block.
    if (parsed.data.isActive !== undefined)
      invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "symptoms.definition.update",
        entity_type: "symptom_definition",
        entity_id: id,
      },
    });

    return apiSuccess(toSymptomDefinitionDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user, actor } = await requireRecordAuth("manage", "illness");

    const gate = await requireIllnessEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const rl = await checkRateLimit(
      `symptoms:definition:${actor.id}`,
      30,
      60_000,
    );
    if (!rl.allowed) {
      return apiError("Too many requests, try again later", 429);
    }

    const { id } = await params;
    const existing = await prisma.symptomDefinition.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        createdAt: true,
        _count: { select: { events: true } },
      },
    });
    if (!existing) return notFound();

    const purge = request.nextUrl.searchParams.get("purge") === "true";
    if (purge) {
      // The FK cascade removes the events with it.
      await prisma.symptomDefinition.delete({ where: { id: existing.id } });
    } else {
      await prisma.symptomDefinition.update({
        where: { id: existing.id },
        data: { isActive: false },
      });
    }

    await auditLog("symptoms.definition.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C3 on the purge arm: the definition and its events are gone, so the
      // audit row names what went. The label stays out (the person's words).
      details: purge
        ? destroyedDetails({
            model: "SymptomDefinition",
            id,
            label: null,
            effectiveAt: existing.createdAt,
            extra: { eventsDeleted: existing._count.events },
          })
        : { definitionId: id, purge },
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "symptoms.definition.delete",
        entity_type: "symptom_definition",
        entity_id: id,
      },
      meta: { purge },
    });

    return apiSuccess({
      deleted: true,
      purged: purge,
      eventsDeleted: purge ? existing._count.events : 0,
    });
  },
);
