import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  correctHealthProfileFact,
  correctLifeFact,
  removeHealthProfileFact,
} from "@/lib/profile/health-facts";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";
import {
  validateCorrectedFactValue,
  type HealthProfileFactKind,
} from "@/lib/validations/health-profile-facts";
import {
  factCorrectionSchema,
  isLifeFactKind,
  parseLifeFactValue,
} from "@/lib/validations/life-circumstances";

type RouteParams = { params: Promise<{ id: string }> };

function invalidValue(): Response {
  return apiError("Value is not valid for this fact kind", 422, {
    errorCode: "anamnesis.fact.invalidValue",
  });
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;
    const parsed = await parseJsonBody(request, factCorrectionSchema, {
      maxBytes: 8 * 1024,
    });
    if (!parsed.ok) return parsed.error;

    const current = await prisma.healthProfileFactRevision.findFirst({
      where: {
        id,
        userId: user.id,
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { kind: true },
    });
    if (!current) return apiError("Current profile fact not found", 404);

    // The value's form follows the stored kind: a string from the closed set
    // for the three original kinds, an object with `schema: 1` for the life
    // circumstances (v1.43, #614).
    const now = new Date();
    const validFrom = parsed.data.validFrom
      ? dateOnlyAtNoonUtc(parsed.data.validFrom)
      : undefined;
    let corrected: { id: string; kind: string } | null;
    if (isLifeFactKind(current.kind)) {
      const value =
        typeof parsed.data.value === "string"
          ? null
          : parseLifeFactValue(current.kind, parsed.data.value);
      if (!value) return invalidValue();
      corrected = await correctLifeFact(user.id, id, value, now, validFrom);
    } else {
      const value =
        typeof parsed.data.value === "string"
          ? validateCorrectedFactValue(
              current.kind as HealthProfileFactKind,
              parsed.data.value,
            )
          : null;
      if (!value) return invalidValue();
      corrected = await correctHealthProfileFact(
        user.id,
        id,
        value,
        now,
        validFrom,
      );
    }
    if (!corrected) {
      return apiError("Profile fact changed since it was loaded", 409, {
        errorCode: "anamnesis.fact.conflict",
      });
    }

    await auditLog("anamnesis.fact.correct", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        priorRevisionId: id,
        revisionId: corrected.id,
        kind: corrected.kind,
      },
    });
    annotate({
      action: {
        name: "anamnesis.fact.correct",
        entity_type: "health_profile_fact_revision",
        entity_id: corrected.id,
      },
      meta: { kind: corrected.kind },
    });
    return apiSuccess(corrected);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    const current = await prisma.healthProfileFactRevision.findFirst({
      where: {
        id,
        userId: user.id,
        validUntil: null,
        supersededByRevisionId: null,
      },
      select: { kind: true },
    });
    if (!current) return apiError("Current profile fact not found", 404);

    const removed = await removeHealthProfileFact(user.id, id);
    if (!removed) {
      return apiError("Profile fact changed since it was loaded", 409, {
        errorCode: "anamnesis.fact.conflict",
      });
    }

    await auditLog("anamnesis.fact.remove", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        revisionId: removed.id,
        kind: removed.kind,
      },
    });
    annotate({
      action: {
        name: "anamnesis.fact.remove",
        entity_type: "health_profile_fact_revision",
        entity_id: removed.id,
      },
      meta: { kind: removed.kind },
    });
    return apiSuccess(removed);
  },
);

export const dynamic = "force-dynamic";
