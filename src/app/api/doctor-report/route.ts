import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import {
  collectDoctorReportData,
  normaliseDateRange,
  sanitisePracticeName,
} from "@/lib/doctor-report-data";
import { prisma } from "@/lib/db";
import { doctorReportPrefsSchema } from "@/lib/validations/doctor-report-prefs";

/**
 * Collect data for doctor report PDF generation (client-side).
 * Returns aggregated health data for the specified time range.
 *
 * Body shape (all fields optional — sensible defaults apply):
 *   {
 *     startDate?: string,   // ISO timestamp, inclusive
 *     endDate?: string,     // ISO timestamp, inclusive
 *     days?: number,        // legacy "last N days" fallback (1..365)
 *     practiceName?: string // free-text, persisted as user preference
 *   }
 *
 * Resolution: explicit range wins; otherwise `days` (default 90) is applied.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "doctor-report.generate" } });

  const rl = await checkRateLimit(
    `doctor-report:${user.id}`,
    10,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Maximum 10 reports per hour", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const range = normaliseDateRange(body);
  const rawPracticeName = (body as Record<string, unknown> | null)
    ?.practiceName;
  const practiceName = sanitisePracticeName(rawPracticeName);

  // v1.4.25 W6c — section toggles. Malformed shapes silently fall
  // through to the documented defaults so a forward-compat client
  // never lands a 422 on a benign drift.
  const rawSections = (body as Record<string, unknown> | null)?.sections;
  const sectionsParsed = doctorReportPrefsSchema.safeParse(rawSections ?? {});
  const sections = sectionsParsed.success ? sectionsParsed.data : {};

  // Persist the most-recent practice name as a user preference so the
  // dialog can pre-fill it next time. We only write when the caller
  // actually supplied a non-empty string — passing `null`/empty does NOT
  // clear the stored preference (use the dedicated profile endpoint for
  // that). Best-effort: a write failure here MUST NOT break the report.
  if (typeof rawPracticeName === "string" && practiceName !== null) {
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { lastReportPracticeName: practiceName },
      });
    } catch {
      // Non-fatal — preference persistence is a UX nicety, not a contract.
    }
  }

  const data = await collectDoctorReportData(user.id, range, {
    practiceName,
    sections,
  });

  await auditLog("doctor-report.generate", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      days: range.days,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      practiceNameProvided: practiceName !== null,
      // v1.4.25 W6c — record which sections were included. The audit
      // trail proves mood data was never aggregated when the toggle
      // was off (privacy contract).
      sections,
    },
  });

  annotate({
    meta: {
      report_days: range.days,
      report_start: range.start.toISOString(),
      report_end: range.end.toISOString(),
      practice_name_provided: practiceName !== null,
    },
  });

  return apiSuccess(data);
});
