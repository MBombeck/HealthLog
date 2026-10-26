/**
 * `POST /api/anamnesis/audit-c` — record an AUDIT-C (#614).
 *
 * `{ items: [0..4, 0..4, 0..4], takenAt?, tz?, locale?, source, externalId? }`.
 * 201 `{ result: AuditCResult }` with the sum and the screening cut-off for
 * the entry's language and the profile's sex (null without one); a replay
 * with the same `externalId` answers 200 with the same result. Stored beside
 * the mental-health screeners but never listed by
 * `/api/mental-health/assessments`. At most 30 an hour, counted against the
 * person acting.
 *
 * Authority: `requireRecordAuth("manage", "profile")`, the level allergies and
 * family history are written at; the entry lands in the record and the trail
 * names the manager as actor.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import { auditCInstrument } from "@/lib/mental-health/audit-c";
import { createAuditC } from "@/lib/profile/life-circumstances";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditCRequestSchema } from "@/lib/validations/life-circumstances";

/** How far ahead of the server clock a `takenAt` may lie. */
const AUDIT_C_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const POST = apiHandler(withIdempotency<[NextRequest]>(postAuditC));

async function postAuditC(request: NextRequest): Promise<Response> {
  const { user, actor } = await requireRecordAuth("manage", "profile");

  const rl = await checkRateLimit(`audit-c:${actor.id}`, 30, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Too many entries, try again later", 429, {
      errorCode: "anamnesis.auditC.rateLimited",
    });
  }

  const parsed = await parseJsonBody(request, auditCRequestSchema, {
    maxBytes: 4 * 1024,
    errorCode: "anamnesis.auditC.invalid",
  });
  if (!parsed.ok) return parsed.error;

  const input = parsed.data;

  // The cut-off follows the language of the wording that was answered, and
  // the only wording this account is ever shown is the one the read route
  // delivers for its language. The stored language is that one, decided
  // here; a client naming another wording answered something this server
  // did not offer (or the account language changed under an open form), and
  // is refused rather than scored against the wrong table.
  const offered = auditCInstrument(user.locale ?? "en").locale;
  if (
    input.locale !== undefined &&
    auditCInstrument(input.locale).locale !== offered
  ) {
    return apiError("The wording answered is not the one offered", 422, {
      errorCode: "anamnesis.auditC.invalid",
    });
  }
  // An entry dated in the future would hold the "newest" place for as long
  // as the clock takes to reach it. A few minutes of device clock skew pass.
  const takenAt = input.takenAt ? new Date(input.takenAt) : undefined;
  if (takenAt && takenAt.getTime() > Date.now() + AUDIT_C_CLOCK_SKEW_MS) {
    return apiError("takenAt lies in the future", 422, {
      errorCode: "anamnesis.auditC.invalid",
    });
  }

  const { result, replayed } = await createAuditC(user.id, {
    items: input.items,
    takenAt,
    tz: input.tz,
    locale: offered,
    source: input.source,
    externalId: input.externalId,
  });

  annotate({
    action: {
      name: replayed ? "anamnesis.audit_c.replay" : "anamnesis.audit_c.create",
      entity_type: "mental_health_assessment",
      entity_id: result.id,
    },
  });
  if (replayed) return apiSuccess({ result }, 200);

  // The id and the instrument only; the answers and the sum stay out of the trail.
  await auditLog("anamnesis.audit_c.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { assessmentId: result.id, instrument: "AUDIT_C" },
  });
  return apiSuccess({ result }, 201);
}
