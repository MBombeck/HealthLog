import { NextRequest, NextResponse } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiError, getClientIp } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  collectDoctorReportData,
  normaliseDateRange,
  sanitisePracticeName,
} from "@/lib/doctor-report-data";
import { prisma } from "@/lib/db";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { parseLocaleFromAcceptLanguage } from "@/lib/format-locale";
import { locales, type Locale } from "@/lib/i18n/config";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/**
 * Server-rendered PDF doctor report.
 *
 * Mirrors `/api/doctor-report` (which returns JSON for client-side rendering)
 * but produces the finished PDF bytes server-side. Useful on iOS / Safari where
 * the client-side jsPDF download UX is unreliable.
 *
 * Auth, rate-limit (10/h), and audit-log policy match the JSON endpoint.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "doctor-report.pdf.generate" } });

  const rl = await checkRateLimit(
    `doctor-report:${user.id}`,
    10,
    60 * 60 * 1000,
  );
  if (!rl.allowed) {
    return apiError("Maximum 10 reports per hour", 429);
  }

  // Body is optional — JSON is allowed but not required.
  const body = await readOptionalJsonBody(request);
  const range = normaliseDateRange(body ?? undefined);
  const locale = resolveLocale(
    body?.locale,
    request.headers.get("accept-language"),
  );
  const rawPracticeName = body?.practiceName;
  const practiceName = sanitisePracticeName(rawPracticeName);

  if (typeof rawPracticeName === "string" && practiceName !== null) {
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { lastReportPracticeName: practiceName },
      });
    } catch {
      // Best-effort; never let preference persistence break the report.
    }
  }

  const [data, userTz] = await Promise.all([
    collectDoctorReportData(user.id, range, { practiceName }),
    resolveUserTimezone(user.id),
  ]);

  const { t } = getServerTranslator(locale);
  const pdfBytes = renderDoctorReportPdfBytes(data, { t, locale, userTz });

  await auditLog("doctor-report.pdf.generate", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      days: range.days,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      locale,
      practiceNameProvided: practiceName !== null,
    },
  });

  annotate({
    meta: {
      report_days: range.days,
      report_start: range.start.toISOString(),
      report_end: range.end.toISOString(),
      locale,
      bytes: pdfBytes.byteLength,
      practice_name_provided: practiceName !== null,
    },
  });

  const filename = `healthlog-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  // NextResponse accepts a BodyInit; copy to a fresh ArrayBuffer to avoid
  // SharedArrayBuffer typing surprises with Uint8Array.
  const buffer = pdfBytes.slice().buffer;
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
});

interface PdfRequestBody {
  days?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  locale?: unknown;
  practiceName?: unknown;
}

/**
 * Best-effort JSON body parse. Returns `null` if the request had no body or
 * a non-JSON content type — both are acceptable for this endpoint.
 */
async function readOptionalJsonBody(
  request: NextRequest,
): Promise<PdfRequestBody | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    return (await request.json()) as PdfRequestBody;
  } catch {
    return null;
  }
}

/**
 * Resolve the active locale: explicit body override wins, then a parsed
 * `Accept-Language`, then a hard fallback to German (the primary HealthLog
 * locale for the medical context).
 */
function resolveLocale(
  bodyLocale: unknown,
  acceptLanguage: string | null,
): Locale {
  if (
    typeof bodyLocale === "string" &&
    (locales as readonly string[]).includes(bodyLocale)
  ) {
    return bodyLocale as Locale;
  }
  if (!acceptLanguage) return "de";
  // parseLocaleFromAcceptLanguage returns "de" for de-* headers, otherwise
  // "en" — matching the broader app's i18n behaviour for present headers.
  return parseLocaleFromAcceptLanguage(acceptLanguage);
}
