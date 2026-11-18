/**
 * The record's own seizure types (#1368).
 *
 *   GET  /api/seizures/types — every type, active first, archived after.
 *   POST /api/seizures/types — set one up: the family's name for it, the
 *        ILAE 2025 type, how long it usually lasts, and the rescue plan
 *        agreed with the care team (the plan text, an as-needed medication,
 *        the dose and the route). At most twelve active types.
 *
 * The name and the plan are encrypted at rest. Setting up a type is MANAGE
 * on a shared record (like defining a symptom); reading is READ.
 * Module-gated (`seizures.disabled`).
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserHealthContext } from "@/lib/cache/invalidate";
import {
  requireSeizuresEnabled,
  seizureMedicationsReachable,
} from "@/lib/seizures/gate";
import {
  checkRescueMedication,
  encryptSeizureText,
  listSeizureTypes,
  MAX_ACTIVE_SEIZURE_TYPES,
  seizureTypeCreateSchema,
  toSeizureTypeDTO,
} from "@/lib/seizures/server";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user, grantId } = await requireRecordAuth("read", "illness");

  const gate = await requireSeizuresEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const types = await listSeizureTypes(user.id, {
    medicationsVisible: await seizureMedicationsReachable(grantId),
  });
  annotate({
    action: { name: "seizures.type.list" },
    meta: { count: types.length },
  });
  return apiSuccess({ types });
});

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("manage", "illness");

  const gate = await requireSeizuresEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const parsed = await parseJsonBody(request, seizureTypeCreateSchema, {
    maxBytes: 16 * 1024,
    errorCode: "seizures.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const t = parsed.data;

  const active = await prisma.seizureTypeProfile.count({
    where: { userId: user.id, archivedAt: null },
  });
  if (active >= MAX_ACTIVE_SEIZURE_TYPES) {
    return apiError("Too many seizure types", 422, {
      errorCode: "seizures.type.limit",
    });
  }

  if (t.rescueMedicationId) {
    const check = await checkRescueMedication(user.id, t.rescueMedicationId);
    if (!check.ok) {
      return apiError(check.message, check.status, {
        errorCode: check.errorCode,
      });
    }
  }

  const created = await prisma.seizureTypeProfile.create({
    data: {
      userId: user.id,
      labelEncrypted: encryptSeizureText(t.label),
      ilaeType: t.ilaeType,
      usualDurationSec: t.usualDurationSec ?? null,
      rescuePlanEncrypted: t.rescuePlan
        ? encryptSeizureText(t.rescuePlan)
        : null,
      rescueMedicationId: t.rescueMedicationId ?? null,
      rescueDoseAmount: t.rescueDoseAmount ?? null,
      rescueDoseUnit: t.rescueDoseUnit ?? null,
      rescueRoute: t.rescueRoute ?? null,
      sortOrder: active,
    },
    include: { rescueMedication: { select: { name: true } } },
  });

  await auditLog("seizures.type.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { typeId: created.id, ilaeType: created.ilaeType },
  });

  invalidateUserHealthContext(user.id);

  annotate({
    action: {
      name: "seizures.type.create",
      entity_type: "seizure_type",
      entity_id: created.id,
    },
    meta: { ilae_type: created.ilaeType },
  });

  return apiSuccess(toSeizureTypeDTO(created), 201);
});
