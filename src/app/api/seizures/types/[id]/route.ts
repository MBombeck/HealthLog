/**
 * One seizure type (#1368).
 *
 *   PATCH  /api/seizures/types/{id} — change the name, classification, usual
 *          duration or rescue plan, reorder it, or archive it (`archived`).
 *          An archived type leaves the quick log and keeps its events.
 *   DELETE /api/seizures/types/{id} — remove a type no seizure names. A type
 *          with seizures answers 409 `seizures.type.inUse`: archive it
 *          instead, so no recorded seizure loses its type.
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
  checkRescueMedication,
  encryptSeizureText,
  MAX_ACTIVE_SEIZURE_TYPES,
  sealOptional,
  seizureTypeUpdateSchema,
  toSeizureTypeDTO,
} from "@/lib/seizures/server";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

function notFound(): Response {
  return apiError("Seizure type not found", 404, {
    errorCode: "seizures.type.notFound",
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireSeizuresEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const parsed = await parseJsonBody(request, seizureTypeUpdateSchema, {
      maxBytes: 16 * 1024,
      errorCode: "seizures.invalid",
    });
    if (!parsed.ok) return parsed.error;
    const t = parsed.data;

    const existing = await prisma.seizureTypeProfile.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        archivedAt: true,
        ilaeType: true,
        usualDurationSec: true,
        rescueMedicationId: true,
        rescueDoseAmount: true,
        rescueDoseUnit: true,
        rescueRoute: true,
        sortOrder: true,
      },
    });
    if (!existing) return notFound();

    if (t.archived === false && existing.archivedAt !== null) {
      const active = await prisma.seizureTypeProfile.count({
        where: { userId: user.id, archivedAt: null },
      });
      if (active >= MAX_ACTIVE_SEIZURE_TYPES) {
        return apiError("Too many seizure types", 422, {
          errorCode: "seizures.type.limit",
        });
      }
    }

    if (t.rescueMedicationId) {
      const check = await checkRescueMedication(user.id, t.rescueMedicationId);
      if (!check.ok) {
        return apiError(check.message, check.status, {
          errorCode: check.errorCode,
        });
      }
    }

    const updated = await prisma.seizureTypeProfile.update({
      where: { id: existing.id },
      data: {
        ...(t.label !== undefined
          ? { labelEncrypted: encryptSeizureText(t.label) }
          : {}),
        ...(t.ilaeType !== undefined ? { ilaeType: t.ilaeType } : {}),
        ...(t.usualDurationSec !== undefined
          ? { usualDurationSec: t.usualDurationSec ?? null }
          : {}),
        ...(t.rescuePlan !== undefined
          ? { rescuePlanEncrypted: sealOptional(t.rescuePlan) }
          : {}),
        ...(t.rescueMedicationId !== undefined
          ? { rescueMedicationId: t.rescueMedicationId ?? null }
          : {}),
        ...(t.rescueDoseAmount !== undefined
          ? { rescueDoseAmount: t.rescueDoseAmount ?? null }
          : {}),
        ...(t.rescueDoseUnit !== undefined
          ? { rescueDoseUnit: t.rescueDoseUnit ?? null }
          : {}),
        ...(t.rescueRoute !== undefined
          ? { rescueRoute: t.rescueRoute ?? null }
          : {}),
        ...(t.sortOrder !== undefined ? { sortOrder: t.sortOrder } : {}),
        ...(t.archived !== undefined
          ? {
              archivedAt: t.archived
                ? (existing.archivedAt ?? new Date())
                : null,
            }
          : {}),
      },
      include: { rescueMedication: { select: { name: true } } },
    });

    await auditLog("seizures.type.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        typeId: id,
        // The family's name and the plan are their own words: named as
        // changed, never quoted.
        ...overwriteDetails({
          before: {
            ilaeType: existing.ilaeType,
            usualDurationSec: existing.usualDurationSec,
            rescueMedicationId: existing.rescueMedicationId,
            rescueDoseAmount: existing.rescueDoseAmount,
            rescueDoseUnit: existing.rescueDoseUnit,
            rescueRoute: existing.rescueRoute,
            sortOrder: existing.sortOrder,
            archived: existing.archivedAt !== null,
          },
          after: {
            ilaeType: updated.ilaeType,
            usualDurationSec: updated.usualDurationSec,
            rescueMedicationId: updated.rescueMedicationId,
            rescueDoseAmount: updated.rescueDoseAmount,
            rescueDoseUnit: updated.rescueDoseUnit,
            rescueRoute: updated.rescueRoute,
            sortOrder: updated.sortOrder,
            archived: updated.archivedAt !== null,
          },
          redacted: [
            ...(t.label !== undefined ? ["label"] : []),
            ...(t.rescuePlan !== undefined ? ["rescuePlan"] : []),
          ],
        }),
      },
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "seizures.type.update",
        entity_type: "seizure_type",
        entity_id: id,
      },
    });

    return apiSuccess(toSeizureTypeDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "illness");

    const gate = await requireSeizuresEnabled(user.id);
    if (!gate.enabled) return gate.response;

    const { id } = await params;
    const existing = await prisma.seizureTypeProfile.findFirst({
      where: { id, userId: user.id },
      select: { id: true, ilaeType: true, createdAt: true },
    });
    if (!existing) return notFound();

    const inUse = await prisma.seizureEvent.count({
      where: { userId: user.id, typeProfileId: existing.id },
    });
    if (inUse > 0) {
      return apiError("Seizures name this type; archive it instead", 409, {
        errorCode: "seizures.type.inUse",
      });
    }

    await prisma.seizureTypeProfile.delete({ where: { id: existing.id } });

    await auditLog("seizures.type.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: destroyedDetails({
        model: "SeizureTypeProfile",
        id,
        label: existing.ilaeType,
        effectiveAt: existing.createdAt,
      }),
    });

    invalidateUserHealthContext(user.id);

    annotate({
      action: {
        name: "seizures.type.delete",
        entity_type: "seizure_type",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
