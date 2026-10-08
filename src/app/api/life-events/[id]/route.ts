/**
 * `PATCH /api/life-events/{id}` edits one life event; `DELETE` soft-deletes
 * it (v1.42, #613). Record-scoped like the list beside it, and MANAGE like
 * the create: correcting or removing somebody's life event is a guardian's
 * act. A foreign, unknown or already deleted id is the same 404.
 *
 * The edit files the replaced dates, category and precision (C4) and names a
 * changed title or note without quoting either. The delete tombstones the
 * row, so the audit row names it and the restore of a backup keeps it.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import {
  lifeEventIdPathSchema,
  lifeEventUpdateSchema,
} from "@/lib/day/wire-schemas";
import { prisma } from "@/lib/db";
import {
  findOwnLifeEvent,
  mergeLifeEventEdit,
  toLifeEventDTO,
} from "@/lib/life-events/service";
import { annotate } from "@/lib/logging/context";
import { overwriteDetails } from "@/lib/sharing/audit-details";

type RouteParams = { params: Promise<{ id: string }> };

function notFound() {
  return apiError("Life event not found", 404, {
    errorCode: "life_event.not_found",
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");
    const path = lifeEventIdPathSchema.safeParse(await params);
    if (!path.success) return notFound();
    const existing = await findOwnLifeEvent(user.id, path.data.id);
    if (!existing) return notFound();

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = lifeEventUpdateSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "life_event.invalid",
      });
    }
    const merged = mergeLifeEventEdit(existing, parsed.data);
    if (!merged.ok) {
      return returnAllZodIssues(merged.error, 422, {
        errorCode: "life_event.invalid",
      });
    }

    const updated = await prisma.lifeEvent.update({
      where: { id: existing.id },
      data: merged.data,
    });

    await auditLog("life_event.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        lifeEventId: existing.id,
        ...overwriteDetails({
          before: {
            category: existing.category,
            startDate: existing.startDate,
            endDate: existing.endDate,
            precision: existing.precision,
          },
          after: {
            category: updated.category,
            startDate: updated.startDate,
            endDate: updated.endDate,
            precision: updated.precision,
          },
          redacted: [
            ...(parsed.data.title !== undefined ? ["title"] : []),
            ...(parsed.data.note !== undefined ? ["note"] : []),
          ],
        }),
      },
    });
    annotate({
      action: {
        name: "life_event.update",
        entity_type: "life_event",
        entity_id: existing.id,
      },
    });
    return apiSuccess(toLifeEventDTO(updated));
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("manage", "profile");
    const path = lifeEventIdPathSchema.safeParse(await params);
    if (!path.success) return notFound();
    const existing = await findOwnLifeEvent(user.id, path.data.id);
    if (!existing) return notFound();

    const deleted = await prisma.lifeEvent.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });

    await auditLog("life_event.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        lifeEventId: existing.id,
        category: existing.category,
        startDate: existing.startDate,
        precision: existing.precision,
      },
    });
    annotate({
      action: {
        name: "life_event.delete",
        entity_type: "life_event",
        entity_id: existing.id,
      },
    });
    return apiSuccess(toLifeEventDTO(deleted));
  },
);
