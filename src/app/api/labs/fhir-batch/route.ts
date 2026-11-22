/**
 * `POST /api/labs/fhir-batch` — lab results from Apple Health's Health
 * Records, sent by the iOS app (#1400).
 *
 * Each record is one FHIR resource as HealthKit hands it over. The batch is
 * mapped with the same mapper the export import uses
 * (`src/lib/labs/fhir-import/map-observation.ts`), panel members are given
 * their panel's name within the batch, and the readings are written with the
 * shared writer, so a result reads the same whichever way it came in and a
 * result that already arrived through an export is a duplicate here.
 *
 * Sending a batch again is safe: a result already held under its identity is
 * `duplicate`, a result the person deleted stays deleted, and an amended
 * result arriving under the same identity is a duplicate (first write wins).
 *
 * Owner-only: a cookie session or a full-scope login token; a narrow token is
 * refused by `requireAuth()`'s default arm. No module gate: labs is a data
 * layer (see `src/app/api/labs/route.ts`). Runs behind the heavy-ingest gate
 * (`src/lib/ingest/admission.ts`) like every bulk sync route, so a first
 * Health Records sync waits its turn with the rest of the phone's batches
 * instead of holding a megabyte body next to them. Metered by its own bulk
 * bucket after admission.
 * Only counts and closed reasons reach the response, the audit row and the
 * wide event; nothing from a resource does.
 */
import { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { parseJsonBody } from "@/lib/api/body";
import { auditLog } from "@/lib/auth/audit";
import { withIdempotency } from "@/lib/idempotency";
import { withIngestAdmission } from "@/lib/ingest/admission";
import { afterLabReadingsWritten } from "@/lib/labs/fhir-import/after-write";
import {
  assignPanels,
  mapFhirLabRecord,
  type FhirLabMapping,
} from "@/lib/labs/fhir-import/map-observation";
import type {
  FhirLabFailureReason,
  FhirLabSkipReason,
  MappedFhirLab,
} from "@/lib/labs/fhir-import/types";
import { writeFhirLabReadings } from "@/lib/labs/fhir-import/write";
import { annotate } from "@/lib/logging/context";
import { classifyWrittenOutcome } from "@/lib/outcome/written-outcome";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import {
  fhirLabBatchSchema,
  MAX_FHIR_LAB_RESOURCE_BYTES,
} from "@/lib/validations/labs-fhir";

const BATCH_RATE_LIMIT_MAX = 60;
const BATCH_RATE_LIMIT_WINDOW_MS = 60 * 1000;
/** The proxy's body ceiling: the route stays inside the proxy matcher. */
const MAX_BODY_BYTES = 1024 * 1024;

type RecordResult =
  | { index: number; status: "inserted" | "duplicate" }
  | { index: number; status: "skipped"; reason: FhirLabSkipReason }
  | { index: number; status: "failed"; reason: FhirLabFailureReason };

export const POST = apiHandler(
  withIngestAdmission(withIdempotency<[NextRequest]>(postBatch)),
);

async function postBatch(request: NextRequest): Promise<Response> {
  const { user } = await requireAuth(undefined, { writeBucket: "own" });
  annotate({ action: { name: "labs.fhir_batch.ingest" } });

  const rl = await checkRateLimit(
    `labs:fhir-batch:${user.id}`,
    BATCH_RATE_LIMIT_MAX,
    BATCH_RATE_LIMIT_WINDOW_MS,
  );
  if (!rl.allowed) {
    return apiError("Too many batch submissions, try again later", 429);
  }

  const parsed = await parseJsonBody(request, fhirLabBatchSchema, {
    maxBytes: MAX_BODY_BYTES,
    action: "labs.fhir_batch.validation-failed",
    countIssues: true,
    errorCode: "labs.fhir_batch.invalid",
  });
  if (!parsed.ok) return parsed.error;
  const { records } = parsed.data;

  // 1. Map every record; nothing is written yet.
  const results: RecordResult[] = new Array(records.length);
  const mapped: Array<{ index: number; mapping: FhirLabMapping }> = [];
  const now = new Date();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      Buffer.byteLength(JSON.stringify(record.resource)) >
      MAX_FHIR_LAB_RESOURCE_BYTES
    ) {
      results[index] = { index, status: "skipped", reason: "too_large" };
      continue;
    }
    const mapping = mapFhirLabRecord(
      {
        resource: record.resource,
        fhirVersion: record.fhirVersion,
        identifier: record.identifier,
        sourceURL: record.sourceURL,
        sourceName: record.sourceName,
      },
      now,
    );
    mapped.push({ index, mapping });
    if (mapping.kind === "skip") {
      results[index] = { index, status: "skipped", reason: mapping.reason };
    } else if (mapping.kind === "fail") {
      results[index] = { index, status: "failed", reason: mapping.reason };
    }
  }

  // 2. A panel and its members arrive in one batch.
  assignPanels(mapped.map((m) => m.mapping));
  const readings: MappedFhirLab[] = [];
  const readingIndex: number[] = [];
  for (const { index, mapping } of mapped) {
    if (mapping.kind !== "reading") continue;
    readings.push(mapping.reading);
    readingIndex.push(index);
  }

  // 3. Write.
  const tz = await resolveUserTimezone(user.id);
  const written = await writeFhirLabReadings({
    userId: user.id,
    tz,
    readings,
  });
  written.statuses.forEach((status, i) => {
    const index = readingIndex[i];
    results[index] =
      status.status === "failed"
        ? { index, status: "failed", reason: status.reason }
        : { index, status: status.status };
  });
  afterLabReadingsWritten({
    userId: user.id,
    inserted: written.inserted,
    newestTakenAt: written.newestTakenAt,
    source: "fhir_batch",
  });

  const counts = { inserted: 0, duplicate: 0, skipped: 0, failed: 0 };
  let writeFailed = false;
  for (const result of results) {
    counts[result.status] += 1;
    if (result.status === "failed" && result.reason === "write_failed") {
      writeFailed = true;
    }
  }

  await auditLog("labs.fhir.batch", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { records: records.length, ...counts },
  });
  annotate({
    meta: {
      records: records.length,
      inserted: counts.inserted,
      duplicate: counts.duplicate,
      skipped: counts.skipped,
      failed: counts.failed,
    },
  });

  const response = apiSuccess({
    results,
    ...counts,
    outcome: classifyWrittenOutcome({
      written: counts.inserted,
      skipped: counts.failed,
    }),
  });
  // `write_failed` is transient: nothing was stored for those records and the
  // client sends them again. `no-store` keeps the idempotency layer from
  // replaying this answer to the retry.
  if (writeFailed) response.headers.set("Cache-Control", "private, no-store");
  return response;
}
