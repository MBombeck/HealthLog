/**
 * Person-defined symptoms (v1.40).
 *
 *   GET  /api/symptoms/definitions — the record's own symptom list with a
 *        30-day summary per symptom. `?includeHidden=true` adds hidden ones.
 *   POST /api/symptoms/definitions — define one (`{ label, icon? }`). At most
 *        eight active definitions; the label is encrypted at rest.
 *
 * Rides the illness module: an account (or instance) with it off answers 403
 * `illness.disabled` even to a valid Bearer token. The label is the person's
 * own words for a health complaint, so it never reaches an audit row or a
 * wide event.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { withIdempotency } from "@/lib/idempotency";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import {
  encryptSymptomText,
  listSymptomDefinitions,
  symptomDefinitionCreateSchema,
  toSymptomDefinitionDTO,
  MAX_ACTIVE_SYMPTOM_DEFINITIONS,
} from "@/lib/symptoms/server";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "illness");

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  const includeHidden =
    request.nextUrl.searchParams.get("includeHidden") === "true";
  const definitions = await listSymptomDefinitions(user.id, { includeHidden });

  annotate({
    action: { name: "symptoms.definition.list" },
    meta: { count: definitions.length, includeHidden },
  });

  return apiSuccess({ definitions, limit: MAX_ACTIVE_SYMPTOM_DEFINITIONS });
});

/**
 * Wrapped in `withIdempotency`: the label is ciphertext under a fresh IV, so
 * no unique index can catch a replayed create, and a retry after a lost
 * response would otherwise mint a second "aura" and burn a slot of eight.
 */
export const POST = apiHandler(withIdempotency<[NextRequest]>(postDefinition));

async function postDefinition(request: NextRequest): Promise<Response> {
  // MANAGE, like the cycle module's own symptom list: the vocabulary of a
  // record is the owner's, a delegate who may log an occurrence picks from it.
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

  const parsed = await parseJsonBody(request, symptomDefinitionCreateSchema, {
    maxBytes: 16 * 1024,
    errorCode: "symptoms.invalid",
  });
  if (!parsed.ok) return parsed.error;

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

  const created = await prisma.symptomDefinition.create({
    data: {
      userId: user.id,
      labelEncrypted: encryptSymptomText(parsed.data.label),
      icon: parsed.data.icon ?? null,
      sortOrder: activeCount,
    },
    select: {
      id: true,
      labelEncrypted: true,
      icon: true,
      sortOrder: true,
      isActive: true,
    },
  });

  await auditLog("symptoms.definition.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { definitionId: created.id, icon: created.icon },
  });

  annotate({
    action: {
      name: "symptoms.definition.create",
      entity_type: "symptom_definition",
      entity_id: created.id,
    },
    meta: { icon: created.icon },
  });

  return apiSuccess(toSymptomDefinitionDTO(created), 201);
}
