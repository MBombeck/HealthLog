/**
 * `POST /api/symptoms/events/batch` — Apple Health symptom samples.
 *
 * The iPhone app sends the HealthKit symptom samples it reads (fever,
 * coughing, headache, ...) as `{ entries: [{ code, occurredAt, endAt?,
 * intensity, externalId, source: "APPLE_HEALTH" }] }`, at most 500 a call.
 * Each lands on the record's built-in definition for its code, created on
 * first use; the per-entry rules live in `src/lib/symptoms/apple-health-ingest.ts`.
 *
 * Answers 200 with the `POST /api/measurements/batch` envelope once the body
 * parses; `Cache-Control: no-store` when an entry `failed`. More than 500
 * entries is 422 `symptoms.batch.too_large`, a malformed body 422
 * `symptoms.batch.invalid`. Idempotent under `Idempotency-Key`.
 *
 * Module-gated on the record (403 `illness.disabled` for the whole call), a
 * delegable write like `POST /api/symptoms/events`, metered by the shared
 * per-account write bucket. A narrow-scope Bearer is refused.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
} from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { withIdempotency } from "@/lib/idempotency";
import { requireIllnessEnabled } from "@/lib/illness/gate";
import { annotate } from "@/lib/logging/context";
import { ingestSymptomBatch } from "@/lib/symptoms/apple-health-ingest";
import {
  MAX_SYMPTOM_BATCH_ENTRIES as MAX_BATCH_ENTRIES,
  symptomBatchPayloadSchema,
  symptomBatchShapeSchema,
} from "@/lib/symptoms/batch-schema";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 1024 * 1024;

export const POST = apiHandler(withIdempotency<[NextRequest]>(postBatch));

async function postBatch(request: NextRequest): Promise<Response> {
  // WRITE, like logging one occurrence: an admitted delegated write.
  const { user } = await requireRecordAuth("write", "illness");

  const gate = await requireIllnessEnabled(user.id);
  if (!gate.enabled) return gate.response;

  // The count first, so a batch over the cap is told apart from a malformed
  // one whatever its entries hold.
  const shape = await parseJsonBody(request, symptomBatchShapeSchema, {
    maxBytes: MAX_BODY_BYTES,
    action: "symptoms.batch.validation-failed",
    countIssues: true,
    errorCode: "symptoms.batch.invalid",
  });
  if (!shape.ok) return shape.error;
  if (shape.data.entries.length > MAX_BATCH_ENTRIES) {
    return apiError(`Batch exceeds the ${MAX_BATCH_ENTRIES}-entry limit`, 422, {
      errorCode: "symptoms.batch.too_large",
    });
  }

  const parsed = symptomBatchPayloadSchema.safeParse(shape.body);
  if (!parsed.success) {
    annotate({
      action: { name: "symptoms.batch.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "symptoms.batch.invalid",
    });
  }

  const result = await ingestSymptomBatch({
    userId: user.id,
    locale: user.locale,
    entries: parsed.data.entries,
    ipAddress: getClientIp(request),
  });

  const response = apiSuccess(result);
  if (result.failed > 0) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}
