/**
 * POST /api/export/health-record — the doctor-handover artefact.
 *
 * One entry point producing one of three formats from one aggregated payload,
 * driven by a strict Zod selection:
 *   - `pdf`     → `application/pdf`
 *   - `fhir`    → `application/fhir+json` (HL7 FHIR R4 document Bundle)
 *   - `package` → `application/zip` (PDF + Bundle + README)
 *
 * Auth: cookie session OR Bearer token, resolved through `requireRecordAuth`
 *   at MANAGE — the report is reachable on a record the caller manages.
 * Rate-limit: shared `export:<actorId>` bucket (10/h).
 * Audit: `health-record.export` — format, window, and the chosen leaf ids,
 *   never the values behind them.
 *
 * The `selection` field is required and carries the leaf inclusion list. An
 * unknown leaf id is a 422 that names it; the old grouped `sections` shape is
 * a 422 too, because accepting it would mean choosing a scope the caller did
 * not express. The rendering itself lives in
 * `src/lib/export/health-record-artefacts.ts`; this route keeps the HTTP
 * concerns.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma, toJson } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { toAllergyDTO, toFamilyHistoryEntryDTO } from "@/lib/records/dto";
import {
  collectDoctorReportData,
  normaliseDateRange,
  sanitisePracticeName,
} from "@/lib/doctor-report-data";
import { GERMAN_ATC_DEFAULT_LOCALES } from "@/lib/fhir/build-bundle";
import { exportSelectionSchema } from "@/lib/validations/health-record-export";
import { selectionFromRequest } from "@/lib/report-selection/selection";
import {
  buildBundleJson,
  buildPackageZip,
  buildPdfBytes,
  type ArtefactInputs,
} from "@/lib/export/health-record-artefacts";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { parseLocaleFromAcceptLanguage } from "@/lib/format-locale";
import { locales, type Locale } from "@/lib/i18n/config";
import { resolveUserTimezone } from "@/lib/tz/resolver";

/**
 * Remember what the owner chose, so the panel opens carrying it next time.
 *
 * Called only once the requested artefact has actually been produced: a
 * generation that throws must not overwrite the remembered scope or a
 * half-typed practice name. `null` is a legitimate practice name — the user
 * cleared the line and the next cover should stay cleared. Both fields are
 * named explicitly rather than spread from the parsed body.
 */
async function rememberChoices(
  userId: string,
  practiceName: string | null,
  profile: {
    v: 2;
    leaves: string[];
    format: "pdf" | "fhir" | "package";
    rangeDays: number;
    includeCharts: boolean;
  },
) {
  await prisma.user.update({
    where: { id: userId },
    data: {
      lastReportPracticeName: practiceName,
      reportSelectionJson: toJson(profile),
    },
  });
}

export const POST = apiHandler(async (request: NextRequest) => {
  // v1.37.0 — MANAGE: the doctor report is the one export an invited manager
  // reaches, because it renders a prepared artefact from a declared selection
  // rather than handing over the record whole.
  const { user, actor } = await requireRecordAuth("manage", "record");
  annotate({ action: { name: "export.health-record.build" } });

  // The whole doctor-report surface is the `doctorReport` module. Refuse with
  // a 403 `module.disabled` envelope when the account turned it off — even
  // with a valid Bearer token.
  const gate = await requireModuleEnabled(user.id, "doctorReport");
  if (!gate.enabled) return gate.response;

  // v1.37.0 — the shared export bucket keys on the ACTOR. A manager burns
  // their own hourly allowance rather than the owner's, and switching records
  // does not hand them a fresh one.
  const rl = await checkRateLimit(`export:${actor.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 exports per hour", 429);
  }

  // The selection payload is small and bounded. 64 KB is far above any
  // legitimate one while still rejecting a multi-megabyte body before it
  // reaches `JSON.parse`. A DoS ceiling, not a tight bound.
  const { data: body, error: jsonError } = await safeJson(request, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = exportSelectionSchema.safeParse(body);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error);
  }
  const input = parsed.data;

  const minted = selectionFromRequest(input.selection);
  if (!minted.ok) {
    annotate({ meta: { unknownLeaves: minted.error.unknownLeaves } });
    return apiError(
      `Unknown selection leaf: ${minted.error.unknownLeaves.join(", ")}`,
      422,
      { errorCode: "export.selection.unknown_leaf" },
    );
  }
  const selection = minted.selection;
  // A selection that admits nothing would render an empty report and still
  // spend a rate-limit slot on it. The panel disables its own submit button
  // in that state; a hand-built request has to be refused here, because this
  // route has no documents-only mode that would make an empty leaf list a
  // legitimate scope (the share-link route, which does, mints EMPTY itself).
  if (selection.leaves.length === 0) {
    annotate({ meta: { empty_selection: true } });
    return apiError("Select at least one section to export", 422, {
      errorCode: "export.selection.empty",
    });
  }

  const range = normaliseDateRange(input.range ?? undefined);
  const practiceName = sanitisePracticeName(input.practiceName);
  const includeCharts = input.includeCharts ?? true;

  // Locale, most-specific first: the explicit selection wins, then the in-app
  // cookie (what the user actually chose in the UI), and only then the
  // browser's Accept-Language header — the weakest signal.
  const cookieValue = request.cookies.get("healthlog-locale")?.value;
  const cookieLocale = (locales as readonly string[]).includes(
    cookieValue ?? "",
  )
    ? (cookieValue as Locale)
    : null;
  const locale: Locale =
    input.locale ??
    cookieLocale ??
    parseLocaleFromAcceptLanguage(request.headers.get("accept-language") ?? "");

  const germanAtc =
    input.germanAtc ??
    (GERMAN_ATC_DEFAULT_LOCALES as readonly string[]).includes(locale);

  const [data, userTz, userRow, allergyRows, familyHistoryRows] =
    await Promise.all([
      collectDoctorReportData(user.id, range, selection, { practiceName }),
      resolveUserTimezone(user.id),
      prisma.user.findUnique({
        where: { id: user.id },
        select: {
          insuranceNumberEncrypted: true,
          timeFormat: true,
          // Issue #922 — the exported PDF is spelled the way the person
          // who exported it reads dates, not the locale default.
          dateFormat: true,
        },
      }),
      // Structured records are always-available reference data (not
      // time-windowed), so they ride alongside the report rather than through
      // the aggregator. Owner-scoped, live rows only — and each read is gated
      // on its own leaf, so a deselected section is not loaded, not merely
      // dropped later.
      selection.has("ALLERGIES")
        ? prisma.allergy.findMany({
            where: { userId: user.id, deletedAt: null },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      selection.has("FAMILY_HISTORY")
        ? prisma.familyHistoryEntry.findMany({
            where: { userId: user.id, deletedAt: null },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
    ]);

  const fhirRecords = {
    allergies: allergyRows.map(toAllergyDTO),
    familyHistory: familyHistoryRows.map(toFamilyHistoryEntryDTO),
  };

  // The KVNR is encrypted at rest and is its own leaf. It is neither read nor
  // decrypted unless the insurance leaf was chosen. The decrypt is fail-soft:
  // a key-rotation gap on one row omits the value rather than 500-ing the
  // export.
  let insuranceNumber: string | null = null;
  if (selection.has("INSURANCE") && userRow?.insuranceNumberEncrypted) {
    try {
      insuranceNumber = decrypt(userRow.insuranceNumberEncrypted);
    } catch {
      insuranceNumber = null;
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const { t } = getServerTranslator(locale);

  const artefact: ArtefactInputs = {
    data,
    insuranceNumber,
    records: fhirRecords,
    germanAtc,
    includeCharts,
    locale,
    userTz,
    timeFormat: userRow?.timeFormat ?? "AUTO",
    dateFormat: userRow?.dateFormat ?? "AUTO",
    t,
  };

  const profile = {
    v: 2 as const,
    leaves: [...selection.leaves],
    format: input.format,
    rangeDays: Math.min(365, Math.max(1, range.days)),
    includeCharts,
  };

  await auditLog("health-record.export", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      format: input.format,
      days: range.days,
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      charts: includeCharts,
      // The chosen leaf ids — never the values behind them.
      leaves: profile.leaves,
    },
  });

  if (input.format === "fhir") {
    const json = buildBundleJson(artefact);
    await rememberChoices(user.id, practiceName, profile);
    annotate({
      meta: {
        format: "fhir",
        bytes: json.length,
        days: range.days,
        leafCount: profile.leaves.length,
      },
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

  const pdfBytes = buildPdfBytes(artefact);
  // Both remaining formats carry the rendered PDF, so the artefact exists from
  // here on.
  await rememberChoices(user.id, practiceName, profile);

  if (input.format === "pdf") {
    annotate({
      meta: {
        format: "pdf",
        bytes: pdfBytes.byteLength,
        days: range.days,
        leafCount: profile.leaves.length,
      },
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

  const zipped = buildPackageZip(artefact, pdfBytes);
  annotate({
    meta: {
      format: "package",
      bytes: zipped.byteLength,
      days: range.days,
      leafCount: profile.leaves.length,
    },
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
