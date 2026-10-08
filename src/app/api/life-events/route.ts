/**
 * `GET /api/life-events` lists the record's life events, oldest first;
 * `POST` adds one (v1.42, #613). Title and note are encrypted at rest and
 * never reach a model. Shapes and request schemas in `src/lib/day/`.
 *
 * Part of the `profile` sharing domain, beside allergies, visits and the
 * immunization history. The row store answers whether or not the `timeline`
 * module is on, the data-layer posture of the other record tables, so a
 * restore keeps working and re-enabling finds the events intact.
 *
 * The create is a MANAGE verb: a life event is the person's own anchor, and
 * recording one for somebody else is a guardian's act on a managed profile,
 * not a helper's. Additive, rate-limited on the actor, audited with the
 * category and the precision and never the title.
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
import { lifeEventCreateSchema } from "@/lib/day/wire-schemas";
import { withIdempotency } from "@/lib/idempotency";
import {
  createLifeEvent,
  listLifeEvents,
  toLifeEventDTO,
} from "@/lib/life-events/service";
import { annotate } from "@/lib/logging/context";
import { checkRecordWriteRateLimit } from "@/lib/rate-limit";

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("read", "profile");
  const events = await listLifeEvents(user.id);
  annotate({
    action: { name: "life_event.list", entity_type: "life_event" },
    meta: { count: events.length },
  });
  return apiSuccess({ events });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postLifeEvent));

async function postLifeEvent(request: NextRequest): Promise<Response> {
  const { user, actor } = await requireRecordAuth("manage", "profile");

  const writeRl = await checkRecordWriteRateLimit(actor.id);
  if (!writeRl.allowed) {
    return apiError("Too many writes, try again later", 429, {
      errorCode: "record_write.rate_limited",
    });
  }

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = lifeEventCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "life_event.invalid",
    });
  }

  const created = await createLifeEvent(user.id, parsed.data);

  await auditLog("life_event.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    // Never the title or the note: both are encrypted at rest and the audit
    // table is not a second store for them.
    details: {
      lifeEventId: created.id,
      category: created.category,
      precision: created.precision,
    },
  });
  annotate({
    action: {
      name: "life_event.create",
      entity_type: "life_event",
      entity_id: created.id,
    },
    meta: { category: created.category, precision: created.precision },
  });
  return apiSuccess(toLifeEventDTO(created), 201);
}
