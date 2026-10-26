import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { createMedicationSchema } from "@/lib/validations/medication";
import {
  unstableExternalIdMeta,
  unstableExternalIdShape,
} from "@/lib/validations/external-id";
import { readMedicationsListCached } from "@/lib/medications/list-read";
import {
  courseActionAuthority,
  withCourseActionAuthority,
} from "@/lib/medications/course-authority";
import { createMedication } from "@/lib/medications/create-medication";
import { withIdempotency } from "@/lib/idempotency";
import { NextRequest } from "next/server";

export const GET = apiHandler(async () => {
  const { user, grantId } = await requireRecordAuth("read", "medications");

  // Cache the list shape on userId. The 60 s fresh TTL bounds the
  // cross-midnight staleness window for `todayEventCount` and the
  // next-due fields; the read goes through `cachedSwr`, so a visit
  // minutes after the last one serves the prior list immediately while
  // one background recompute warms a fresh entry (the 10-minute stale
  // window bounds how old that served list can be). Interactive writes
  // via POST/PUT/DELETE hard-evict through
  // `invalidateUserMedications({ evict: true })` before the next read
  // lands; background sync paths mark the bucket stale instead. The RSC
  // wrapper (`src/app/medications/page.tsx`) shares this exact cell.
  const cached = await readMedicationsListCached(user);
  // The cell is the record's; End and Start are narrowed to the caller after
  // it, so one caller's authority never lands in another's answer (#1280).
  const authority = await courseActionAuthority(grantId);
  const result = cached.map((row) => withCourseActionAuthority(row, authority));

  annotate({
    action: { name: "medication.list" },
    meta: { count: result.length },
  });

  return apiSuccess(result);
});

/**
 * The create is wrapped in `withIdempotency` so a client replaying its offline
 * outbox after a lost success response replays the first answer instead of
 * minting a second medication. The `(externalSource, externalId)` dedupe in
 * `createMedication` only ever covered a MIRRORED create; a manually entered
 * medication carries neither field and had nothing to collapse a retry onto.
 */
export const POST = apiHandler(withIdempotency<[NextRequest]>(postMedication));

async function postMedication(request: NextRequest): Promise<Response> {
  // v1.36.x — a delegated write, and the asymmetric one: a delegate can ADD a
  // medication with its whole nested schedule, and can never edit or delete
  // it afterwards — `PUT /api/medications/[id]` and the DELETE beside it stay
  // on `requireAuth()` and refuse under a switch. Adding is help; rewriting
  // the owner's cabinet is not.
  const { user, grantId } = await requireRecordAuth("write", "medications");

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;
  const parsed = createMedicationSchema.safeParse(body);
  if (!parsed.success) {
    // Surface an unstable concept id as its own wide event: the refusal
    // is the visible half of the phantom-mirror class, and a silent 422
    // in the generic bucket is how it stayed invisible the first time.
    const shape = unstableExternalIdShape(body);
    if (shape) {
      annotate({
        action: { name: "medication.external_id.rejected" },
        meta: unstableExternalIdMeta("medication.create", [shape]),
      });
    }
    // v1.4.43 — multi-issue 422.
    return returnAllZodIssues(parsed.error, 422);
  }

  const outcome = await createMedication({
    user,
    grantId,
    data: parsed.data,
    ipAddress: getClientIp(request),
  });
  switch (outcome.kind) {
    case "refused":
      return apiError(outcome.message, outcome.status, outcome.meta);
    case "existing":
      return apiSuccess(outcome.body);
    case "created":
      return apiSuccess(outcome.body, 201);
  }
}
