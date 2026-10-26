import {
  apiHandler,
  isScopedCredential,
  requireRecordAuth,
} from "@/lib/api-handler";
import { MEASUREMENTS_WRITE_SCOPE } from "@/lib/measurements/scopes";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import {
  createMeasurementSchema,
  createBatchMeasurementSchema,
  listMeasurementsSchema,
} from "@/lib/validations/measurement";
import { withIdempotency } from "@/lib/idempotency";
import { shapeMeasurementNotes } from "@/lib/crypto/note-cipher";
import {
  type MeasurementWithMirrorInput,
  withAppleHealthMirror,
} from "@/lib/measurements/apple-health-mirror";
import { measurementListResponse } from "@/lib/measurements/list/measurement-list";
import {
  createReading,
  createReadings,
  type ReadingWriter,
} from "@/lib/measurements/create/create-readings";
import { createNamedSleepStage } from "@/lib/measurements/create/create-sleep-stage";
import {
  isNamedSleepStageBody,
  sleepStageEntrySchema,
} from "@/lib/validations/sleep-stage-entry";
import { NextRequest } from "next/server";

const DUPLICATE_MESSAGE = "A measurement with this data already exists";
const DUPLICATE_META = { errorCode: "measurement.duplicate_timestamp" };

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMeasurementsSchema.safeParse(params);
  if (!parsed.success) {
    // v1.4.43 — surface every Zod issue under `details.issues` so a
    // multi-field iOS query (chart loader bug, drill-down regression)
    // doesn't iterate one error per round-trip. Best-effort audit-
    // ledger breadcrumb keyed `measurements.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "measurements.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row to keep
    // any free-text query slice (custom `dayKey`, attacker-shaped
    // `type=`) out of the persisted breadcrumb.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only thing that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a delegate's malformed query would read as the owner's own.
    void auditLog("measurements.list.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  return measurementListResponse(user, parsed.data);
});

/**
 * Does this body attribute a source to any reading — any source at all?
 *
 * Read off the RAW body rather than the parsed result, and that is load-bearing
 * twice over. It has to give the same answer for the object arm and the array
 * arm, which parse against different schemas further down; and
 * `createMeasurementSchema.source` carries `.default("MANUAL")`, so after
 * parsing "said MANUAL" and "said nothing" are the same value and the
 * distinction this predicate exists to draw is already gone.
 *
 * v1.38.x — widened from "names APPLE_HEALTH" to "names anything". Under a
 * scoped credential the row's source is now resolved by the server, so an
 * explicit `MANUAL` is an assertion the route would have to override — which
 * is the silent relabelling the refusal below refuses to do.
 *
 * Anything that is not a recognisable measurement shape answers false and
 * falls through to the validation error it has coming: this function decides
 * attribution, not validity.
 */
function namesAnySource(body: unknown): boolean {
  const names = (entry: unknown): boolean =>
    typeof entry === "object" &&
    entry !== null &&
    (entry as { source?: unknown }).source !== undefined;
  return Array.isArray(body) ? body.some(names) : names(body);
}

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMeasurement));

async function postMeasurement(request: NextRequest) {
  // v1.36.x — a delegated write. `user` is the record the reading belongs to,
  // which every `userId: user.id` below already meant; the caller is somebody
  // who may or may not be that person. Nothing else in this handler reads the
  // caller: the safety-floor check, the reminder satisfaction, the rollup
  // recompute and the cache eviction are all statements about the record.
  //
  // v1.38.x — it also declares the third-party ingest scope, so a narrow
  // `measurements:write` token reaches this arm. The two declarations do not
  // interact: a scoped credential is refused the moment the request names
  // another record, before any grant is read, so "delegable" and "reachable by
  // a bridge token" stay separate properties of the same route.
  const auth = await requireRecordAuth("write", "measurements", {
    scope: MEASUREMENTS_WRITE_SCOPE,
  });
  const { user } = auth;
  const scoped = isScopedCredential(auth);

  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });

  if (jsonError) return jsonError;

  // A scoped credential may attribute nothing: the source of its rows is
  // `EXTERNAL`, decided here from the credential rather than taken from the
  // body. Checked before the validation branches so the object and array arms
  // share one answer, and refused rather than rewritten for the reason the
  // batch route gives: relabelling a client's explicit assertion hands it rows
  // it did not ask for and no way to notice.
  //
  // v1.38.x — this used to refuse only an explicit `APPLE_HEALTH`, because the
  // forced value was `MANUAL` and so a body naming `MANUAL` was never actually
  // overridden. Now that bridge rows carry their own provenance, honouring
  // such a body would defeat the point (a bridge that kept sending `MANUAL`
  // would stay indistinguishable from a typed reading) and overriding it
  // silently is what the paragraph above forbids. Status and `errorCode` are
  // unchanged, so client error handling is untouched; the documented Home
  // Assistant payload sends no `source` at all.
  if (scoped && namesAnySource(body)) {
    annotate({ action: { name: "measurements.create.source-not-permitted" } });
    return apiError(
      "This credential resolves the source itself; omit the field",
      422,
      { errorCode: "measurement.create.source_not_permitted" },
    );
  }

  const writer: ReadingWriter = {
    user: { id: user.id, timezone: user.timezone },
    scoped,
    // On the Bearer path the token's id rides `session.id`.
    ingestTokenId: scoped ? auth.session.id : null,
    ipAddress: getClientIp(request),
  };

  // One sleep-stage segment, the stage named rather than coded. A bridge
  // (Tasker, Home Assistant) posts here with its narrow token; the row and
  // its dedupe are the batch route's. See `sleep-stage-entry.ts`.
  if (isNamedSleepStageBody(body)) {
    return postNamedSleepStage(writer, body);
  }

  // Batch mode (array of measurements, e.g. combined BP + Pulse)
  if (Array.isArray(body)) {
    const parsed = createBatchMeasurementSchema.safeParse({
      measurements: body,
    });
    if (!parsed.success) {
      // v1.4.43 — iOS batch ingest (BP + Pulse, combined BG) needs
      // every issue echoed back so a one-shot retry can fix the full
      // payload rather than walk it field-by-field.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "measurements.create.batch.validation-failed" },
        meta: { issue_count: issues.length },
      });
      // v1.4.49 — strip `message` from the audit-ledger row; batch
      // rows carry free-text `notes` per measurement.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      // v1.36.x — through `auditLog()` rather than a bare `prisma.auditLog
      // .create`, because that helper is the only thing that stamps
      // `actorUserId`. Filed under the resolved record either way; without the
      // stamp a delegate's malformed batch would read as the owner's own.
      void auditLog("measurements.create.batch.validation-failed", {
        userId: user.id,
        details: { issues: auditIssues },
      }).catch(() => {
        /* swallow — 422 response is the contract */
      });
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "measurement.create.invalid",
      });
    }

    const created = await createReadings(writer, parsed.data);
    if ("duplicate" in created) {
      return apiError(DUPLICATE_MESSAGE, 409, DUPLICATE_META);
    }
    return apiSuccess(created.rows.map(answerRow), 201);
  }

  // Single mode (existing behavior)
  const parsed = createMeasurementSchema.safeParse(body);
  if (!parsed.success) {
    // v1.4.43 — single-row POST is the iOS fallback path; one
    // round-trip per stale-field bug was the v1.4.41 iOS-contract
    // pain point. Multi-issue envelope + audit breadcrumb.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "measurements.create.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // v1.4.49 — strip `message` from the audit-ledger row; single
    // measurement carries free-text `notes`.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.x — see the batch arm above: only `auditLog()` stamps the actor.
    void auditLog("measurements.create.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "measurement.create.invalid",
    });
  }

  const created = await createReading(writer, parsed.data);
  if ("duplicate" in created) {
    return apiError(DUPLICATE_MESSAGE, 409, DUPLICATE_META);
  }
  return apiSuccess(answerRow(created.row), 201);
}

/** A written row as it is answered: the note readable, the write-back resolved. */
function answerRow(row: MeasurementWithMirrorInput) {
  return withAppleHealthMirror(shapeMeasurementNotes(row));
}

/**
 * The named sleep-stage arm: validated here, stored by
 * `createNamedSleepStage` (see its header for the dedupe and the answers).
 */
async function postNamedSleepStage(
  writer: ReadingWriter,
  body: unknown,
): Promise<Response> {
  const parsed = sleepStageEntrySchema.safeParse(body);
  if (!parsed.success) {
    annotate({
      action: { name: "measurements.create.sleep-stage.validation-failed" },
      meta: { issue_count: sanitiseZodIssues(parsed.error.issues).length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "measurement.create.invalid",
    });
  }
  return createNamedSleepStage(
    {
      userId: writer.user.id,
      scoped: writer.scoped,
      ingestTokenId: writer.ingestTokenId,
      ipAddress: writer.ipAddress,
    },
    parsed.data,
  );
}
