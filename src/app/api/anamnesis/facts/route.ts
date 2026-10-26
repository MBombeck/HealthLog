import { NextRequest } from "next/server";

import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import {
  createHealthProfileFact,
  createLifeFact,
  readHealthProfileFacts,
} from "@/lib/profile/health-facts";
import { dateOnlyAtNoonUtc } from "@/lib/tz/date-only";
import { factWriteSchema } from "@/lib/validations/life-circumstances";

/**
 * `GET` lists the three closed kinds only (`SMOKING_STATUS`, `ALCOHOL_PATTERN`,
 * `SHIFT_SCHEDULE`): older app builds decode this list closed. `POST` also
 * takes the six life-circumstance kinds (v1.43, #614), which are read back
 * through `GET /api/anamnesis/life-circumstances`.
 */
export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "profile");
  const payload = await readHealthProfileFacts(user.id);
  annotate({
    action: { name: "anamnesis.facts.get" },
    meta: {
      current_count: Object.values(payload.current).filter(Boolean).length,
      revision_count: payload.history.length,
    },
  });
  return apiSuccess(payload);
});

async function postFact(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();
  const parsed = await parseJsonBody(request, factWriteSchema, {
    maxBytes: 8 * 1024,
  });
  if (!parsed.ok) return parsed.error;

  const now = new Date();
  const validFrom = parsed.data.validFrom
    ? dateOnlyAtNoonUtc(parsed.data.validFrom)
    : undefined;
  try {
    const input = parsed.data;
    const fact =
      input.kind === "SMOKING_STATUS" ||
      input.kind === "ALCOHOL_PATTERN" ||
      input.kind === "SHIFT_SCHEDULE"
        ? await createHealthProfileFact(
            user.id,
            input.kind,
            input.value,
            now,
            validFrom,
          )
        : await createLifeFact(
            user.id,
            input.kind,
            input.value,
            now,
            validFrom,
          );
    await auditLog("anamnesis.fact.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { revisionId: fact.id, kind: fact.kind },
    });
    annotate({
      action: {
        name: "anamnesis.fact.create",
        entity_type: "health_profile_fact_revision",
        entity_id: fact.id,
      },
      meta: { kind: fact.kind },
    });
    return apiSuccess(fact, 201);
  } catch (error) {
    if (isP2002(error)) {
      return apiError("A current value already exists for this fact", 409, {
        errorCode: "anamnesis.fact.currentExists",
      });
    }
    throw error;
  }
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postFact));

export const dynamic = "force-dynamic";
