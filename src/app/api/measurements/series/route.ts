/**
 * GET /api/measurements/series?kind=&days=
 *
 * iOS-friendly time-series adapter. Maps the camelCase `kind` to the
 * canonical Prisma `MeasurementType`(s) and returns
 *   { kind, points: [{ id, at, value, secondary }], stats }
 *
 * The `kind=bloodPressure` case pairs systolic + diastolic by
 * `measuredAt` so iOS can render the dual-line chart with one fetch.
 *
 * v1.43 (ios #116 items 3 and 4) — the answer also carries what a client
 * would otherwise decide itself: `direction` (which way a change of this
 * metric counts for this person), `change` (first and last day value of the
 * window, judged by that direction) and `referenceLines` (the person's own
 * target lines, else the clinical ones, in the unit of the points).
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";
import { auditLog } from "@/lib/auth/audit";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import {
  apiSuccess,
  buildPayloadDiagnostic,
  returnAllZodIssues,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { redactForExcerpt } from "@/lib/observability/redact-payload";
import { kindEnum } from "@/lib/measurements/series/kinds";
import { readSeries } from "@/lib/measurements/series/read-series";

const querySchema = z.object({
  kind: kindEnum,
  // v1.5.5 — the 365-day cap rejected the iOS app's "Alle"-range
  // request (days = 3650) with a 422, painting an error banner on
  // every metric tile. Ten years matches the recurrence engine's
  // nextOccurrenceAfter hard cap and the medication course-window
  // upper bound, so the ceiling stays consistent across the surface
  // area that the user can wire to a "show me everything" intent.
  days: z.coerce.number().int().min(1).max(3650).optional().default(30),
});

export const GET = apiHandler(async (request: NextRequest) => {
  const { user, actor } = await requireRecordAuth("read", "measurements");

  const rawQuery = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) {
    // v1.4.43 — iOS chart loader hot path; multi-issue 422 +
    // audit breadcrumb keyed `measurements.series.validation-failed`.
    const issues = sanitiseZodIssues(parsed.error.issues);
    // v1.4.48 H-iOS-2 — surface the iOS-sent query shape alongside
    // the Zod rejection. Top-level keys + a hard 256-char JSON excerpt
    // only; never the full payload, so token-shaped query params (we
    // do not currently accept any but the truncation keeps that
    // invariant cheap) cannot leak. Shared helper via v1.4.49 so the
    // widget + series routes can't drift on the diagnostic shape; the
    // query map is routed through `redactForExcerpt` first so any
    // future credential-shaped query string (`token`, `apiKey`,
    // `csrfState`) redacts to `"[redacted]"` before the truncate.
    const payloadDiagnostic = buildPayloadDiagnostic(
      redactForExcerpt(rawQuery),
    );
    annotate({
      action: { name: "measurements.series.validation-failed" },
      meta: {
        issue_count: issues.length,
        ...payloadDiagnostic,
        zod_issues: issues,
      },
    });
    // v1.4.49 — strip `message` from the audit-ledger row so Zod
    // codes that embed the offending value (`invalid_enum_value` etc.)
    // cannot leak user content through the audit surface.
    const auditIssues = sanitiseZodIssues(parsed.error.issues, {
      stripValuesFromMessage: true,
    });
    // v1.36.0 — through `auditLog()` rather than a bare `prisma.auditLog
    // .create`, because that helper is the only thing that stamps
    // `actorUserId`. Filed under the resolved record either way; without the
    // stamp a delegate's malformed query would read as the owner's own.
    void auditLog("measurements.series.validation-failed", {
      userId: user.id,
      details: { issues: auditIssues },
    }).catch(() => {
      /* swallow — 422 response is the contract */
    });
    return returnAllZodIssues(parsed.error, 422);
  }

  const { kind, days } = parsed.data;
  return apiSuccess(
    await readSeries({ userId: user.id, actorId: actor.id, kind, days }),
  );
});
