/**
 * POST /api/export/health-record  — v1.7.0 flagship health-record export.
 *
 * One entry point that produces the doctor-handover artefact in one of three
 * formats, driven by a strict Zod selection payload:
 *   - `pdf`     → `application/pdf` (enhanced clinical report)
 *   - `fhir`    → `application/fhir+json` (HL7 FHIR R4 document Bundle)
 *   - `package` → `application/zip` (PDF + FHIR + README in one download)
 *
 * Auth: cookie session OR Bearer token (`requireAuth`).
 * Rate-limit: shared `export:<userId>` bucket (10/h) — so structured + PDF
 *   + CSV exports cannot be parallelised past the cap.
 * Audit: `health-record.export` (records format/days/sections/charts — never
 *   the values).
 *
 * Strict validation: unlike the legacy doctor-report route (which tolerates
 * drift), this route fails loudly — `.strict()` + `returnAllZodIssues` returns
 * a 422 multi-issue envelope on any unknown key (including any attempt to
 * smuggle a `userId`, which is always narrowed from `requireAuth()`).
 */
import { NextRequest, NextResponse } from "next/server";
import { zipSync, strToU8 } from "fflate";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  collectDoctorReportData,
  normaliseDateRange,
  sanitisePracticeName,
} from "@/lib/doctor-report-data";
import { renderDoctorReportPdfBytes } from "@/lib/doctor-report-pdf-core";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import {
  exportSelectionSchema,
  toDoctorReportPrefs,
} from "@/lib/validations/health-record-export";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { parseLocaleFromAcceptLanguage } from "@/lib/format-locale";
import { locales, type Locale } from "@/lib/i18n/config";
import { resolveUserTimezone } from "@/lib/tz/resolver";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "export.health-record.build" } });

  const rl = await checkRateLimit(`export:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const parsed = exportSelectionSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error);
  }
  const selection = parsed.data;

  const range = normaliseDateRange(selection.range ?? undefined);
  const practiceName = sanitisePracticeName(selection.practiceName);
  const sections = toDoctorReportPrefs(selection.sections);
  const includeCharts = selection.includeCharts ?? true;

  // Locale resolution, most-specific first: the explicit selection wins, then
  // the in-app `healthlog-locale` cookie (what the user actually chose in the
  // UI), and only then the browser's Accept-Language header. The header is the
  // weakest signal — a German user on an English-default browser would
  // otherwise get an English report.
  const cookieValue = request.cookies.get("healthlog-locale")?.value;
  const cookieLocale = (locales as readonly string[]).includes(
    cookieValue ?? "",
  )
    ? (cookieValue as Locale)
    : null;
  const locale: Locale =
    selection.locale ??
    cookieLocale ??
    parseLocaleFromAcceptLanguage(
      request.headers.get("accept-language") ?? "",
    );

  const [data, userTz, userRow] = await Promise.all([
    collectDoctorReportData(user.id, range, { practiceName, sections }),
    resolveUserTimezone(user.id),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { insuranceNumberEncrypted: true, insightsCachedText: true },
    }),
  ]);

  // Decrypt the KVNR fail-soft: a key-rotation gap on one row should
  // never 500 the export — the cover/identifier just omits the value.
  let insuranceNumber: string | null = null;
  if (userRow?.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(userRow.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }

  // AI summary is OUT of the clinical PDF by default — only included when
  // the user explicitly toggled `includeAiSummary` AND a cached briefing
  // text exists. Never reaches the FHIR bundle (not a clinical observation).
  const aiSummary =
    selection.includeAiSummary && userRow?.insightsCachedText
      ? extractAiSummaryText(userRow.insightsCachedText)
      : null;

  const stamp = new Date().toISOString().slice(0, 10);

  await auditLog("health-record.export", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      format: selection.format,
      days: range.days,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      charts: includeCharts,
      aiSummary: aiSummary !== null,
      // Section toggles only (booleans) — never the underlying values.
      sections,
    },
  });

  if (selection.format === "fhir") {
    const bundle = buildFhirDocumentBundle(data, { insuranceNumber });
    const json = JSON.stringify(bundle);
    annotate({
      meta: { format: "fhir", bytes: json.length, days: range.days },
    });
    return new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/fhir+json; charset=utf-8",
        "Content-Disposition": `attachment; filename="healthlog-fhir-${stamp}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const { t } = getServerTranslator(locale);
  const pdfBytes = renderDoctorReportPdfBytes(data, {
    t,
    locale,
    userTz,
    insuranceNumber,
    includeCharts,
    aiSummary,
  });

  if (selection.format === "pdf") {
    annotate({
      meta: { format: "pdf", bytes: pdfBytes.byteLength, days: range.days },
    });
    const buffer = pdfBytes.slice().buffer;
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="healthlog-report-${stamp}.pdf"`,
        "Content-Length": String(pdfBytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  }

  // format === "package": one zip holding the PDF + FHIR Bundle + a README.
  const bundle = buildFhirDocumentBundle(data, { insuranceNumber });
  const readme = t("doctorReport.packageReadme");
  const zipped = zipSync(
    {
      "report.pdf": pdfBytes,
      "bundle.json": strToU8(JSON.stringify(bundle, null, 2)),
      "README.txt": strToU8(readme),
    },
    { level: 6 },
  );
  annotate({
    meta: { format: "package", bytes: zipped.byteLength, days: range.days },
  });
  const zipBuffer = zipped.slice().buffer;
  return new NextResponse(zipBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="healthlog-health-record-${stamp}.zip"`,
      "Content-Length": String(zipped.byteLength),
      "Cache-Control": "no-store",
    },
  });
});

/**
 * Extract plain summary text from the cached insights JSON blob. The cache
 * is provider-shaped JSON; we pull the human-readable summary field if
 * present, else fall back to a trimmed stringification. Always plain text
 * (no markdown rendering — the PDF prints React-free string children).
 */
function extractAiSummaryText(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidate =
      (typeof parsed.summary === "string" && parsed.summary) ||
      (typeof parsed.text === "string" && parsed.text) ||
      (typeof parsed.briefing === "string" && parsed.briefing) ||
      null;
    if (candidate) return candidate.trim().slice(0, 4000);
    return null;
  } catch {
    // Not JSON — treat as plain text.
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed.slice(0, 4000) : null;
  }
}
