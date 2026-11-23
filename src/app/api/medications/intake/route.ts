/**
 * Top-level medication-intake aggregator + writer.
 *
 *   GET  /api/medications/intake?scope=today
 *     → array of today's intake events for the user (across medications).
 *
 *   GET  /api/medications/intake?scope=compliance&days=N
 *     → per-day { date, scheduled, taken } for the last N days.
 *
 *   POST /api/medications/intake
 *     Body: { intakeId, status: "taken" | "skipped" | "snoozed", takenAt?, snoozedUntil? }
 *     Updates the named MedicationIntakeEvent and returns the updated row.
 */
import { NextRequest } from "next/server";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import {
  intakeAggregateQuerySchema,
  intakeStatusUpdateSchema,
} from "@/lib/validations/medication";
import { refuseUntrackedIntake } from "@/lib/medications/route-guards";
import { readTodayIntakes } from "@/lib/medications/intake-today";
import { contentEtag, matchesEtag } from "@/lib/http/etag";
import { readIntakeCompliance } from "@/lib/medications/intake-compliance";
import { findIntakeForStatusUpdate } from "@/lib/medications/update-intake-status/admission";
import { updateIntakeStatus } from "@/lib/medications/update-intake-status/update-intake-status";

/** The instant the today rows were read (`scope=today`, 200 and 304). */
const TODAY_AS_OF_HEADER = "HealthLog-As-Of";

// The query + body schemas live in `@/lib/validations/medication` since this
// endpoint joined the published contract: the OpenAPI registry generates from
// the validation modules, and a schema that only exists inside a handler is
// one the spec has to restate — which is a second copy to keep in step.

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "medications");

  const parsed = intakeAggregateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    // Multi-issue 422 + audit breadcrumb keyed
    // `medications.intake.list.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.list.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // Strip `message` from the audit-ledger row; iOS-sent query strings can
    // flow into Zod issue messages.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // Through `auditLog()` rather than a bare `prisma.auditLog.create`,
    // because that helper is the only thing that stamps `actorUserId`. Filed
    // under the resolved record either way; without the stamp a delegate's
    // malformed query would read as the owner's own.
    void auditLog("medications.intake.list.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { scope, days } = parsed.data;

  // Anchor "today" and per-day compliance buckets to the user's display
  // timezone so a 23:30 reading in Pacific/Auckland lands in today's bucket
  // rather than yesterday's Berlin one.
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  if (scope === "today") {
    // A content ETag over the exact body: any change to the rows (an edit,
    // a new row, a tombstone, a dose whose state moved with the clock) moves
    // it, so a cold start confirms its cached rows with a 304 before it
    // shows a dose as due.
    //
    // `HealthLog-As-Of` names the instant the rows were read, taken before
    // the read, so no change committed after it can be in them. A device
    // compares it with the `asOf` of a dose push: a push that is newer tells
    // a change the list does not show yet. A header and not a body field,
    // so it never moves the ETag.
    const asOf = new Date();
    const rows = await readTodayIntakes({ userId: user.id, userTz });
    const etag = contentEtag(JSON.stringify({ data: rows, error: null }));
    const headers = {
      ETag: etag,
      [TODAY_AS_OF_HEADER]: asOf.toISOString(),
      "Cache-Control": "private, no-cache",
    };
    if (matchesEtag(request, etag)) {
      annotate({ meta: { "medications.intake.today.not_modified": true } });
      return new Response(null, { status: 304, headers });
    }
    const response = apiSuccess(rows);
    for (const [name, value] of Object.entries(headers)) {
      response.headers.set(name, value);
    }
    return response;
  }

  return apiSuccess(
    await readIntakeCompliance({ userId: user.id, days, userTz }),
  );
});

export const POST = apiHandler(async (request: NextRequest) => {
  // A delegated write, the canonical slot form. Everything the handler does
  // downstream addresses the RECORD and stays correct; what the owner gets
  // is the notification at the end of the update.
  const { user, actor, authMethod } = await requireRecordAuth(
    "write",
    "medications",
  );

  const { data: body, error } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (error) return error;

  const parsed = intakeStatusUpdateSchema.safeParse(body);
  if (!parsed.success) {
    // Intake-event update hot path; multi-issue 422 + audit breadcrumb keyed
    // `medications.intake.update.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    annotate({
      action: { name: "medications.intake.update.validation-failed" },
      meta: { issue_count: issues.length },
    });
    // Strip `message` from the audit-ledger row.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // Through `auditLog()`, the only writer that stamps the actor.
    void auditLog("medications.intake.update.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const existing = await findIntakeForStatusUpdate({
    userId: user.id,
    intakeId: parsed.data.intakeId,
  });
  if (!existing) {
    return apiError("Intake event not found", 404);
  }

  const outcome = await updateIntakeStatus(
    {
      user,
      actorId: actor.id,
      existing,
      ipAddress: getClientIp(request),
      originDeviceToken: request.headers.get("x-device-id"),
      takenVia: authMethod === "bearer" ? "APP" : "WEB",
    },
    parsed.data,
  );
  if (outcome.kind === "untracked") return refuseUntrackedIntake();
  if (outcome.kind === "refused") {
    return apiError(outcome.message, outcome.status, {
      errorCode: outcome.errorCode,
    });
  }
  return apiSuccess(outcome.row);
});
