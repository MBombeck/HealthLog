/**
 * `GET /api/life-events` lists the account's life events, oldest first;
 * `POST` adds one (v1.42, #613). Title and note are encrypted at rest and
 * never reach a model. Shapes and request schemas in `src/lib/day/`.
 *
 * Owner-only in v1.42. A life event (a loss, a separation, a new job) is
 * the most personal row the record holds, and no share level was ever
 * worded for it, so no delegate reaches it: not a `profile` share, not a
 * legacy whole-record share, not MANAGE, not a guardian acting for a
 * managed profile. Bare `requireAuth()`, which refuses under an
 * acting-account switch and refuses a narrow Bearer scope. Sharing life
 * events is a separate decision for a later release.
 *
 * The row store answers whether or not the `timeline` module is on, the
 * data-layer posture of the other record tables, so a restore keeps working
 * and re-enabling finds the events intact. The create is additive,
 * rate-limited, audited with the category and the precision and never the
 * title.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
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
  const { user } = await requireAuth();
  const events = await listLifeEvents(user.id);
  annotate({
    action: { name: "life_event.list", entity_type: "life_event" },
    meta: { count: events.length },
  });
  return apiSuccess({ events });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postLifeEvent));

async function postLifeEvent(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth();

  const writeRl = await checkRecordWriteRateLimit(user.id);
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
