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
import { readIntakeCompliance } from "@/lib/medications/intake-compliance";
import { findIntakeForStatusUpdate } from "@/lib/medications/update-intake-status/admission";
import { updateIntakeStatus } from "@/lib/medications/update-intake-status/update-intake-status";

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
    return apiSuccess(await readTodayIntakes({ userId: user.id, userTz }));
  }

  return apiSuccess(
    await readIntakeCompliance({ userId: user.id, days, userTz }),
  );
});

export const POST = apiHandler(async (request: NextRequest) => {
  // A delegated write, the canonical slot form. Everything the handler does
  // downstream addresses the RECORD and stays correct; what the owner gets
  // is the notification at the end of the update.
  const { user, actor } = await requireRecordAuth("write", "medications");

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
